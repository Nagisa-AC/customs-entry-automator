import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXTRACTION_SCHEMA_VERSION, parsePageExtraction, type PageExtraction } from "../schema.ts";
import { PAGE_PROMPT, PROMPT_VERSION } from "./prompt.ts";
import { ProviderError, type ExtractionProvider, type PageInput, type Usage } from "./types.ts";

export interface ExtractOptions {
  provider: ExtractionProvider;
  /** Directory for per-page raw and validated outputs. */
  outDir: string;
  /** Reuse a saved raw response when its cache key matches (default true). */
  useCache?: boolean;
  timeoutMs?: number;
  /** Retries for transient provider errors only. */
  maxRetries?: number;
  retryDelayMs?: number;
}

/** Saved verbatim per page so any later stage can be replayed without calling the model. */
export interface RawPageRecord {
  cacheKey: string;
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  page: number;
  latencyMs: number;
  usage: Usage | null;
  attempts: number;
  rawText: string;
}

export interface PageOutcome {
  page: number;
  status: "extracted" | "failed";
  /** Structured reason; never document content. */
  error: string | null;
  cached: boolean;
  provider: string;
  model: string;
  latencyMs: number | null;
  usage: Usage | null;
  extraction: PageExtraction | null;
}

const pad = (n: number) => String(n).padStart(3, "0");

export function pageCacheKey(provider: ExtractionProvider, input: PageInput): string {
  return createHash("sha256")
    .update(JSON.stringify([provider.id, provider.model, PROMPT_VERSION, EXTRACTION_SCHEMA_VERSION, input.page, input.imageSha256, input.textSha256]))
    .digest("hex");
}

async function readRecord(path: string): Promise<RawPageRecord | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RawPageRecord;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callProvider(
  provider: ExtractionProvider,
  input: PageInput,
  opts: Required<Pick<ExtractOptions, "timeoutMs" | "maxRetries" | "retryDelayMs">>,
): Promise<{ record: Omit<RawPageRecord, "cacheKey"> } | { error: string }> {
  let attempts = 0;
  for (;;) {
    attempts++;
    const started = performance.now();
    try {
      const response = await provider.extractPage(input, PAGE_PROMPT, AbortSignal.timeout(opts.timeoutMs));
      return {
        record: {
          provider: provider.id,
          model: provider.model,
          promptVersion: PROMPT_VERSION,
          schemaVersion: EXTRACTION_SCHEMA_VERSION,
          page: input.page,
          latencyMs: Math.round(performance.now() - started),
          usage: response.usage,
          attempts,
          rawText: response.rawText,
        },
      };
    } catch (err) {
      const transient =
        err instanceof ProviderError ? err.transient : err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const reason = err instanceof ProviderError ? err.message : err instanceof Error ? err.name : "unknown error";
      if (!transient || attempts > opts.maxRetries) {
        return { error: `provider ${provider.id} failed after ${attempts} attempt(s): ${reason}` };
      }
      await sleep(opts.retryDelayMs * 2 ** (attempts - 1));
    }
  }
}

function validate(record: RawPageRecord, page: number): { extraction: PageExtraction } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(record.rawText);
  } catch {
    return { error: "provider output is not valid JSON" };
  }
  const parsed = parsePageExtraction(json);
  if (!parsed.ok) return { error: `schema validation failed: ${parsed.errors.slice(0, 5).join("; ")}` };
  if (parsed.value.page !== page) return { error: `provider returned page ${parsed.value.page} for page ${page}` };
  return { extraction: parsed.value };
}

/**
 * One provider call per page; every raw response is saved before it is
 * validated, and reused on later runs when the cache key matches, so
 * re-runs give identical results without calling the model.
 */
export async function extract(pages: readonly PageInput[], options: ExtractOptions): Promise<PageOutcome[]> {
  const { provider, outDir } = options;
  const useCache = options.useCache ?? true;
  const callOpts = {
    timeoutMs: options.timeoutMs ?? 120_000,
    maxRetries: options.maxRetries ?? 2,
    retryDelayMs: options.retryDelayMs ?? 1_000,
  };
  await mkdir(outDir, { recursive: true });

  const outcomes: PageOutcome[] = [];
  for (const input of pages) {
    const rawPath = join(outDir, `page-${pad(input.page)}.raw.json`);
    const validPath = join(outDir, `page-${pad(input.page)}.json`);
    const cacheKey = pageCacheKey(provider, input);
    const base = { page: input.page, provider: provider.id, model: provider.model };

    const saved = useCache ? await readRecord(rawPath) : null;
    const cached = saved !== null && saved.cacheKey === cacheKey;
    let rec: RawPageRecord;
    if (cached) {
      rec = saved;
    } else {
      const result = await callProvider(provider, input, callOpts);
      if ("error" in result) {
        outcomes.push({ ...base, status: "failed", error: result.error, cached: false, latencyMs: null, usage: null, extraction: null });
        continue;
      }
      rec = { cacheKey, ...result.record };
      await writeFile(rawPath, JSON.stringify(rec, null, 2) + "\n");
    }
    const checked = validate(rec, input.page);
    const common = { ...base, cached, latencyMs: rec.latencyMs, usage: rec.usage };
    if ("error" in checked) {
      await writeFile(validPath, JSON.stringify({ page: input.page, status: "failed", error: checked.error }, null, 2) + "\n");
      outcomes.push({ ...common, status: "failed", error: checked.error, extraction: null });
    } else {
      await writeFile(validPath, JSON.stringify(checked.extraction, null, 2) + "\n");
      outcomes.push({ ...common, status: "extracted", error: null, extraction: checked.extraction });
    }
  }
  return outcomes;
}
