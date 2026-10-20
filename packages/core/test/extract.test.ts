import { fixtureDir } from "@cea/fixtures";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extract,
  ExtractedLine,
  FixtureProvider,
  PAGE_EXTRACTION_JSON_SCHEMA,
  PageExtraction,
  ProviderError,
  type ExtractionProvider,
  type PageInput,
  type ProviderResponse,
} from "../src/index.ts";

const tmp = () => mkdtemp(join(tmpdir(), "cea-extract-"));
const recorded = (name: string) => join(fixtureDir(name), "extractions");

function inputs(count: number, imageSha = "img"): PageInput[] {
  return Array.from({ length: count }, (_, i) => ({
    page: i + 1,
    pageCount: count,
    imagePath: "/dev/null",
    imageSha256: `${imageSha}-${i + 1}`,
    text: "",
    textSha256: `txt-${i + 1}`,
  }));
}

class CountingProvider implements ExtractionProvider {
  readonly id: string;
  readonly model: string;
  calls = 0;
  constructor(
    private readonly respond: (input: PageInput, call: number, signal: AbortSignal) => Promise<ProviderResponse>,
    id = "test",
    model = "m1",
  ) {
    this.id = id;
    this.model = model;
  }
  extractPage(input: PageInput, _prompt: string, signal: AbortSignal) {
    this.calls++;
    return this.respond(input, this.calls, signal);
  }
}

function replaying(name: string, model = "m1") {
  const inner = new FixtureProvider(recorded(name));
  return new CountingProvider((input) => inner.extractPage(input), "test", model);
}

describe("extract()", () => {
  it("makes one call per page and validates each against the schema", async () => {
    const provider = replaying("multipage-split-rows");
    const out = await extract(inputs(3), { provider, outDir: await tmp() });
    expect(provider.calls).toBe(3);
    expect(out.map((o) => o.status)).toEqual(["extracted", "extracted", "extracted"]);
    expect(out.every((o) => o.cached === false)).toBe(true);
    expect(out[1]!.extraction?.lines[0]?.continuedFromPreviousPage).toBe(true);
  });

  it("saves raw output per page with provenance", async () => {
    const dir = await tmp();
    await extract(inputs(3), { provider: replaying("multipage-split-rows"), outDir: dir });
    expect((await readdir(dir)).sort()).toEqual([
      "page-001.json", "page-001.raw.json", "page-002.json", "page-002.raw.json", "page-003.json", "page-003.raw.json",
    ]);
    const raw = JSON.parse(await readFile(join(dir, "page-002.raw.json"), "utf8"));
    expect(raw).toMatchObject({ provider: "test", model: "m1", promptVersion: "page-prompt-v1", schemaVersion: "extraction-v1", page: 2, attempts: 1 });
    expect(typeof raw.rawText).toBe("string");
    expect(raw.cacheKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replays from saved raw output without calling the provider, with identical results", async () => {
    const dir = await tmp();
    const first = await extract(inputs(3), { provider: replaying("multipage-split-rows"), outDir: dir });
    const again = replaying("multipage-split-rows");
    const second = await extract(inputs(3), { provider: again, outDir: dir });
    expect(again.calls).toBe(0);
    expect(second.every((o) => o.cached)).toBe(true);
    const strip = (os: typeof first) => os.map(({ cached: _c, ...rest }) => rest);
    expect(strip(second)).toEqual(strip(first));
  });

  it("re-calls when the page image or the model changes", async () => {
    const dir = await tmp();
    await extract(inputs(3), { provider: replaying("multipage-split-rows"), outDir: dir });
    const changedImage = replaying("multipage-split-rows");
    await extract(inputs(3, "other"), { provider: changedImage, outDir: dir });
    expect(changedImage.calls).toBe(3);
    const changedModel = replaying("multipage-split-rows", "m2");
    await extract(inputs(3, "other"), { provider: changedModel, outDir: dir });
    expect(changedModel.calls).toBe(3);
  });

  it("can bypass the cache", async () => {
    const dir = await tmp();
    await extract(inputs(1), { provider: replaying("clean-us-single-page"), outDir: dir });
    const p = replaying("clean-us-single-page");
    await extract(inputs(1), { provider: p, outDir: dir, useCache: false });
    expect(p.calls).toBe(1);
  });

  it("retries transient errors with backoff, then succeeds", async () => {
    const inner = new FixtureProvider(recorded("clean-us-single-page"));
    const p = new CountingProvider(async (input, call) => {
      if (call < 3) throw new ProviderError("HTTP 503", true);
      return inner.extractPage(input);
    });
    const [o] = await extract(inputs(1), { provider: p, outDir: await tmp(), retryDelayMs: 1 });
    expect(p.calls).toBe(3);
    expect(o!.status).toBe("extracted");
  });

  it("does not retry non-transient errors and fails the page visibly", async () => {
    const p = new CountingProvider(async () => {
      throw new ProviderError("HTTP 400", false);
    });
    const dir = await tmp();
    const [o] = await extract(inputs(1), { provider: p, outDir: dir, retryDelayMs: 1 });
    expect(p.calls).toBe(1);
    expect(o).toMatchObject({ status: "failed", error: "provider test failed after 1 attempt(s): HTTP 400" });
    expect(await readdir(dir)).toEqual([]);
  });

  it("gives up after bounded retries", async () => {
    const p = new CountingProvider(async () => {
      throw new ProviderError("HTTP 429", true);
    });
    const [o] = await extract(inputs(1), { provider: p, outDir: await tmp(), retryDelayMs: 1, maxRetries: 2 });
    expect(p.calls).toBe(3);
    expect(o!.status).toBe("failed");
  });

  it("times out slow providers", async () => {
    const p = new CountingProvider(
      (_input, _call, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const [o] = await extract(inputs(1), { provider: p, outDir: await tmp(), timeoutMs: 20, maxRetries: 0 });
    expect(o).toMatchObject({ status: "failed" });
    expect(o!.error).toMatch(/TimeoutError/);
  });

  it.each([
    ["not json", "provider output is not valid JSON"],
    [JSON.stringify({ schemaVersion: "extraction-v1", page: 1, header: {}, lines: [] }), "schema validation failed"],
  ])("rejects malformed output (%s) but keeps the raw response", async (rawText, error) => {
    const dir = await tmp();
    const p = new CountingProvider(async () => ({ rawText, usage: null }));
    const [o] = await extract(inputs(1), { provider: p, outDir: dir });
    expect(o!.status).toBe("failed");
    expect(o!.error).toContain(error);
    expect(JSON.parse(await readFile(join(dir, "page-001.raw.json"), "utf8")).rawText).toBe(rawText);
  });

  it("rejects output for the wrong page", async () => {
    const inner = new FixtureProvider(recorded("multipage-split-rows"));
    const p = new CountingProvider(() => inner.extractPage({ ...inputs(2)[1]! }));
    const [o] = await extract(inputs(1), { provider: p, outDir: await tmp() });
    expect(o!.error).toMatch(/schema validation failed|returned page 2/);
  });

  it("fixture provider fails non-transiently when a page has no recording", async () => {
    const provider = new FixtureProvider(recorded("clean-us-single-page"));
    const out = await extract(inputs(2), { provider, outDir: await tmp() });
    expect(out[1]).toMatchObject({ status: "failed", error: "provider fixture failed after 1 attempt(s): no recorded extraction for page 2" });
  });
});

describe("provider JSON schema", () => {
  it("matches the Zod schema's fields", () => {
    expect([...PAGE_EXTRACTION_JSON_SCHEMA.required].sort()).toEqual(Object.keys(PageExtraction.shape).sort());
    expect([...PAGE_EXTRACTION_JSON_SCHEMA.properties.lines.items.required].sort()).toEqual(Object.keys(ExtractedLine.shape).sort());
  });
});
