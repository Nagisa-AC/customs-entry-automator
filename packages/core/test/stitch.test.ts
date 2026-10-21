import { fixtureDir, listFixtures } from "@cea/fixtures";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extract,
  FixtureProvider,
  normalizeDocument,
  runRules,
  stitch,
  type CheckResult,
  type ExtractedLine,
  type PageExtraction,
  type PageInput,
  type PageOutcome,
} from "../src/index.ts";
import { line } from "./helpers.ts";

interface GroundTruth {
  pageCount: number;
  decimalFormat: string;
  header: Record<string, string>;
  lines: Record<string, string | number | null>[];
  expectedFailures: { ruleId: string; row: number | null }[];
}

const gtOf = async (name: string) => JSON.parse(await readFile(join(fixtureDir(name), "ground-truth.json"), "utf8")) as GroundTruth;

function inputs(count: number): PageInput[] {
  return Array.from({ length: count }, (_, i) => ({
    page: i + 1, pageCount: count, imagePath: "/dev/null", imageSha256: `i${i}`, text: "", textSha256: `t${i}`,
  }));
}

async function extractFixture(name: string): Promise<PageOutcome[]> {
  const gt = await gtOf(name);
  return extract(inputs(gt.pageCount), {
    provider: new FixtureProvider(join(fixtureDir(name), "extractions")),
    outDir: await mkdtemp(join(tmpdir(), "cea-stitch-")),
  });
}

const emptyHeader = {
  invoiceNumber: null, invoiceDate: null, currency: null, sellerName: null, buyerName: null,
  incoterms: null, invoiceTotal: null, totalGrossWeight: null, totalNetWeight: null,
};

function outcome(page: number, lines: ExtractedLine[], header: Partial<PageExtraction["header"]> = {}): PageOutcome {
  return {
    page, status: "extracted", error: null, cached: false, provider: "t", model: "m", latencyMs: 0, usage: null,
    extraction: { schemaVersion: "extraction-v1", page, header: { ...emptyHeader, ...header }, lines },
  };
}

const failed = (page: number): PageOutcome => ({
  page, status: "failed", error: "schema validation failed", cached: false, provider: "t", model: "m", latencyMs: null, usage: null, extraction: null,
});

describe("stitch() on synthetic fixtures", () => {
  it.each(listFixtures())("%s: stitched + normalized lines equal ground truth", async (name) => {
    const gt = await gtOf(name);
    const { document, findings } = stitch(await extractFixture(name), gt.pageCount);
    expect(findings.filter((f) => f.outcome === "fail")).toEqual([]);
    const n = normalizeDocument(document);
    expect(n.decimalFormat).toBe(gt.decimalFormat);
    expect(n.header.invoiceNumber).toBe(gt.header.invoiceNumber);
    expect(n.header.currency).toBe(gt.header.currency);
    expect(n.header.invoiceTotal?.value).toBe(gt.header.invoiceTotal);
    expect(n.header.incoterms).toBe(gt.header.incoterms);
    expect(`${n.header.totalGrossWeight?.value} / ${n.header.totalNetWeight?.value}`).toBe(
      `${gt.header.totalGrossWeight!.split(" ")[0]} / ${gt.header.totalNetWeight!.split(" ")[0]}`,
    );
    expect(
      n.lines.map((l) => ({
        row: l.row, page: l.page, sku: l.sku, description: l.description, quantity: l.quantity?.value ?? null,
        unitOfMeasure: l.unitOfMeasure, unitPrice: l.unitPrice?.value ?? null, extendedPrice: l.extendedPrice?.value ?? null,
        countryOfOrigin: l.countryOfOrigin,
      })),
    ).toEqual(gt.lines.map(({ hts10: _h, ...rest }) => rest));
  });

  it.each(listFixtures())("%s: rule failures are exactly the expected ones", async (name) => {
    const gt = await gtOf(name);
    const { document } = stitch(await extractFixture(name), gt.pageCount);
    const n = normalizeDocument(document);
    const fails = [...n.findings, ...runRules(n)].filter((c) => c.outcome === "fail");
    expect(fails.map((f) => ({ ruleId: f.ruleId, row: f.row }))).toEqual(gt.expectedFailures);
  });

  it("merges both split rows in the multi-page fixture and reports each merge", async () => {
    const { findings, document } = stitch(await extractFixture("multipage-split-rows"), 3);
    const merges = findings.filter((f) => f.ruleId === "stitch-split-row");
    expect(merges.map((m) => [m.row, m.page, m.outcome])).toEqual([[16, 1, "pass"], [33, 2, "pass"]]);
    expect(document.lines).toHaveLength(40);
    expect(document.lines.some((l) => l.continuesOnNextPage || l.continuedFromPreviousPage)).toBe(false);
  });
});

describe("stitch() edge cases", () => {
  const head = line({ rowOnPage: 5, quantity: null, unitOfMeasure: null, unitPrice: null, extendedPrice: null, countryOfOrigin: null, description: "Steel", continuesOnNextPage: true });
  const tail = line({ page: 2, sku: null, description: "bracket", continuedFromPreviousPage: true });

  it("takes the first non-null header value and reports conflicts", () => {
    const { document, findings } = stitch(
      [outcome(1, [], { invoiceNumber: "A-1" }), outcome(2, [], { invoiceNumber: "A-2", invoiceTotal: "10.00" })],
      2,
    );
    expect(document.header.invoiceNumber).toBe("A-1");
    expect(document.header.invoiceTotal).toBe("10.00");
    expect(findings[0]).toMatchObject({ ruleId: "stitch-header-conflict", severity: "blocking", page: 2, expected: "A-1", actual: "A-2" });
  });

  it("merges a split row and joins the description", () => {
    const { document } = stitch([outcome(1, [head]), outcome(2, [tail])], 2);
    expect(document.lines).toHaveLength(1);
    expect(document.lines[0]).toMatchObject({ page: 1, rowOnPage: 5, sku: "ab-100", description: "Steel bracket", quantity: "10", continuesOnNextPage: false, continuedFromPreviousPage: false });
  });

  it("merges on a one-sided flag but reports it for verification", () => {
    const { document, findings } = stitch([outcome(1, [head]), outcome(2, [{ ...tail, continuedFromPreviousPage: false }])], 2);
    expect(document.lines).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "stitch-split-row", outcome: "fail", severity: "warning" });
  });

  it("does not merge halves that both carry values; leaves them for page-continuity to block", () => {
    const { document } = stitch([outcome(1, [head]), outcome(2, [{ ...tail, sku: "OTHER" }])], 2);
    expect(document.lines).toHaveLength(2);
    const checks = runRules(normalizeDocument(document)).filter((c: CheckResult) => c.ruleId === "R7-page-continuity" && c.outcome === "fail");
    expect(checks.length).toBeGreaterThan(0);
  });

  it("does not merge across a failed page", () => {
    const { document } = stitch([outcome(1, [head]), failed(2), outcome(3, [{ ...tail, page: 3 }])], 3);
    expect(document.lines).toHaveLength(2);
    expect(document.pages[1]).toEqual({ page: 2, status: "failed", error: "schema validation failed" });
  });

  it("keeps a row repeated across a page break and leaves it for R6", () => {
    const a = line({ rowOnPage: 9 });
    const b = line({ page: 2, rowOnPage: 1 });
    const { document, findings } = stitch([outcome(1, [a]), outcome(2, [b])], 2);
    expect(document.lines).toHaveLength(2);
    expect(findings).toEqual([]);
    const r6 = runRules(normalizeDocument(document)).filter((c) => c.ruleId === "R6-duplicate-lines" && c.outcome === "fail");
    expect(r6).toMatchObject([{ severity: "warning", row: 2, page: 2 }]);
  });

  it("orders pages regardless of input order", () => {
    const { document } = stitch([outcome(2, [tail]), outcome(1, [head])], 2);
    expect(document.lines).toHaveLength(1);
  });
});
