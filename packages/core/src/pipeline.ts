import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CATALOG_MATCHER_VERSION, loadCatalog, matchCatalog, type MatchResult } from "./catalog.ts";
import type { CheckResult } from "./checks.ts";
import { buildReport, EXPORTER_VERSION, REPORT_VERSION, toLinesCsv, type Report } from "./export.ts";
import { extract, type ExtractOptions, type PageOutcome } from "./extract/extract.ts";
import { PROMPT_VERSION } from "./extract/prompt.ts";
import { stitch, STITCHER_VERSION, type StitchResult } from "./extract/stitch.ts";
import type { ExtractionProvider, PageInput } from "./extract/types.ts";
import { normalizeDocument, NORMALIZER_VERSION, type NormalizedDocument } from "./normalizer.ts";
import { loadPdf, type PdfLimits } from "./pdf/load.ts";
import { RULE_SET_VERSION, runRules } from "./rules.ts";
import { EXTRACTION_SCHEMA_VERSION, type PageExtraction } from "./schema.ts";

export const STAGES = ["render", "extract", "stitch", "normalize", "validate", "match", "export"] as const;
export type Stage = (typeof STAGES)[number];

export interface PipelineOptions {
  pdfPath: string;
  skuSheetPath: string;
  outDir: string;
  provider: ExtractionProvider;
  /** Stages before this one are read back from `outDir` instead of recomputed. */
  from?: Stage;
  useCache?: boolean;
  pdfLimits?: Partial<PdfLimits>;
  extract?: Pick<ExtractOptions, "timeoutMs" | "maxRetries" | "retryDelayMs">;
}

interface PagesManifest {
  pdfFile: string;
  sha256: string;
  pageCount: number;
  pages: { page: number; width: number; height: number; image: string; imageSha256: string; text: string; textSha256: string; hasTextLayer: boolean }[];
}

interface ExtractManifest {
  provider: string;
  model: string;
  pages: Omit<PageOutcome, "extraction" | "cached">[];
}

interface MatchedFile extends MatchResult {
  catalog: { file: string; sha256: string; findings: CheckResult[] };
}

export interface PipelineResult {
  report: Report;
  /** Pages whose extraction came from the saved raw cache vs. a provider call (this run only). */
  cachedPages: number;
  calledPages: number;
  /** lines.csv when nothing blocks; lines.review.csv otherwise. Never both. */
  linesFile: "lines.csv" | "lines.review.csv";
}

const pad = (n: number) => String(n).padStart(3, "0");
const writeJson = (path: string, v: unknown) => writeFile(path, JSON.stringify(v, null, 2) + "\n");
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;

export const PIPELINE_VERSIONS = {
  schema: EXTRACTION_SCHEMA_VERSION,
  prompt: PROMPT_VERSION,
  stitcher: STITCHER_VERSION,
  normalizer: NORMALIZER_VERSION,
  ruleSet: RULE_SET_VERSION,
  catalogMatcher: CATALOG_MATCHER_VERSION,
  exporter: EXPORTER_VERSION,
  report: REPORT_VERSION,
};

/**
 * Run the M1 pipeline. Each stage writes its output under `outDir`:
 * pages/ → extract/ → stitched.json → normalized.json → checks.json →
 * matched.json → report.json + lines.csv, or lines.review.csv when any
 * blocking finding exists (lines.csv is then never written, and a stale one
 * from an earlier run is removed).
 */
export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const { outDir, provider } = opts;
  const fromIndex = STAGES.indexOf(opts.from ?? "render");
  const paths = {
    pages: join(outDir, "pages"),
    pagesManifest: join(outDir, "pages", "manifest.json"),
    extract: join(outDir, "extract"),
    extractManifest: join(outDir, "extract", "manifest.json"),
    stitched: join(outDir, "stitched.json"),
    normalized: join(outDir, "normalized.json"),
    checks: join(outDir, "checks.json"),
    matched: join(outDir, "matched.json"),
    csv: join(outDir, "lines.csv"),
    reviewCsv: join(outDir, "lines.review.csv"),
    report: join(outDir, "report.json"),
  };
  await mkdir(outDir, { recursive: true });
  const replay = (stage: Stage) => STAGES.indexOf(stage) < fromIndex;

  let pages: PagesManifest;
  if (replay("render")) {
    pages = await readJson<PagesManifest>(paths.pagesManifest);
  } else {
    const loaded = await loadPdf(opts.pdfPath, paths.pages, opts.pdfLimits);
    pages = {
      pdfFile: basename(opts.pdfPath),
      sha256: loaded.sha256,
      pageCount: loaded.pageCount,
      pages: loaded.pages.map((p) => ({
        page: p.page, width: p.width, height: p.height, image: basename(p.imagePath), imageSha256: p.imageSha256,
        text: basename(p.textPath), textSha256: p.textSha256, hasTextLayer: p.hasTextLayer,
      })),
    };
    await writeJson(paths.pagesManifest, pages);
  }

  let outcomes: PageOutcome[];
  let cachedPages: number;
  let calledPages = 0;
  if (replay("extract")) {
    const manifest = await readJson<ExtractManifest>(paths.extractManifest);
    outcomes = await Promise.all(
      manifest.pages.map(async (p) => ({
        ...p,
        cached: true,
        extraction: p.status === "extracted" ? await readJson<PageExtraction>(join(paths.extract, `page-${pad(p.page)}.json`)) : null,
      })),
    );
    cachedPages = outcomes.length;
  } else {
    const inputs: PageInput[] = await Promise.all(
      pages.pages.map(async (p) => ({
        page: p.page,
        pageCount: pages.pageCount,
        imagePath: join(paths.pages, p.image),
        imageSha256: p.imageSha256,
        text: await readFile(join(paths.pages, p.text), "utf8"),
        textSha256: p.textSha256,
      })),
    );
    outcomes = await extract(inputs, { provider, outDir: paths.extract, ...(opts.useCache === undefined ? {} : { useCache: opts.useCache }), ...opts.extract });
    cachedPages = outcomes.filter((o) => o.cached).length;
    calledPages = outcomes.length - cachedPages;
    const manifest: ExtractManifest = {
      provider: provider.id,
      model: provider.model,
      pages: outcomes.map(({ extraction: _e, cached: _c, ...rest }) => rest),
    };
    await writeJson(paths.extractManifest, manifest);
  }

  let stitched: StitchResult;
  if (replay("stitch")) stitched = await readJson<StitchResult>(paths.stitched);
  else await writeJson(paths.stitched, (stitched = stitch(outcomes, pages.pageCount)));

  let normalized: NormalizedDocument;
  if (replay("normalize")) normalized = await readJson<NormalizedDocument>(paths.normalized);
  else await writeJson(paths.normalized, (normalized = normalizeDocument(stitched.document)));

  let ruleChecks: CheckResult[];
  if (replay("validate")) ruleChecks = await readJson<CheckResult[]>(paths.checks);
  else await writeJson(paths.checks, (ruleChecks = runRules(normalized)));

  let matched: MatchedFile;
  if (replay("match")) {
    matched = await readJson<MatchedFile>(paths.matched);
  } else {
    const catalog = await loadCatalog(opts.skuSheetPath);
    matched = { catalog: { file: catalog.file, sha256: catalog.sha256, findings: catalog.findings }, ...matchCatalog(normalized, catalog) };
    await writeJson(paths.matched, matched);
  }

  const checks = [...stitched.findings, ...normalized.findings, ...ruleChecks, ...matched.catalog.findings, ...matched.checks];
  const report = buildReport({
    input: {
      pdfFile: pages.pdfFile,
      pdfSha256: pages.sha256,
      pageCount: pages.pageCount,
      skuSheetFile: matched.catalog.file,
      skuSheetSha256: matched.catalog.sha256,
    },
    versions: { ...PIPELINE_VERSIONS },
    extraction: {
      provider: outcomes[0]?.provider ?? provider.id,
      model: outcomes[0]?.model ?? provider.model,
      pages: outcomes.map((o) => ({
        page: o.page, status: o.status, error: o.error, latencyMs: o.latencyMs,
        inputTokens: o.usage?.inputTokens ?? null, outputTokens: o.usage?.outputTokens ?? null,
      })),
    },
    lineCount: matched.lines.length,
    matched: matched.lines.filter((l) => l.match.status === "matched").length,
    checks,
  });
  const blocked = report.summary.blocking > 0;
  const [target, stale] = blocked ? [paths.reviewCsv, paths.csv] : [paths.csv, paths.reviewCsv];
  await rm(stale, { force: true });
  await writeFile(target, toLinesCsv(matched.lines, normalized.header.currency, checks));
  await writeJson(paths.report, report);

  return { report, cachedPages, calledPages, linesFile: blocked ? "lines.review.csv" : "lines.csv" };
}
