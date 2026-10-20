import { INVOICES_DIR } from "@cea/fixtures";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  comparisonMarkdown,
  FixtureProvider,
  listLabeledInvoices,
  normalizeDocument,
  runComparison,
  scoreInvoice,
  SimulatedNoisyProvider,
  type GroundTruth,
  type MatchedLine,
  type Report,
} from "../src/index.ts";
import { cleanDoc } from "./helpers.ts";

const providers = [
  { name: "recorded", create: (dir: string) => new FixtureProvider(join(dir, "extractions")) },
  { name: "noisy", create: (dir: string) => new SimulatedNoisyProvider(join(dir, "extractions")) },
];

describe("runComparison on the synthetic labeled set", () => {
  it("scores providers against ground truth and writes comparison files", async () => {
    const out = await mkdtemp(join(tmpdir(), "cea-compare-"));
    const [recorded, noisy] = await runComparison({
      setDir: INVOICES_DIR,
      outDir: out,
      providers,
      prices: { "simulated-noisy": { inputPerMTok: 3, outputPerMTok: 15 } },
    });

    expect(recorded!.invoices).toBe(listLabeledInvoices(INVOICES_DIR).length);
    expect(recorded!.lineRecall).toBe(1);
    expect(recorded!.linePrecision).toBe(1);
    expect(Object.values(recorded!.fieldAccuracy).every((v) => v === 1)).toBe(true);
    expect(recorded!.silentErrors).toBe(0);
    expect(recorded!.costUsd).toBeNull();

    expect(noisy!.lineRecall).toBeLessThan(1);
    expect(noisy!.fieldAccuracy.quantity).toBeLessThan(1);
    expect(noisy!.fieldAccuracy.countryOfOrigin).toBeLessThan(1);
    expect(noisy!.silentErrors).toBeGreaterThan(0);
    expect(noisy!.costUsd).toBeCloseTo((noisy!.inputTokens * 3 + noisy!.outputTokens * 15) / 1e6, 6);

    const json = JSON.parse(await readFile(join(out, "comparison.json"), "utf8"));
    expect(json).toHaveLength(2);
    expect(await readFile(join(out, "comparison.md"), "utf8")).toContain("| Silent errors | 0 |");
  }, 60_000);
});

describe("scoreInvoice", () => {
  const gt: GroundTruth = {
    invoice: "t",
    header: { invoiceNumber: "INV-1001", currency: "USD", invoiceTotal: "1525" },
    lines: [
      { row: 1, sku: "AB-100", description: "Steel bracket", quantity: "10", unitPrice: "2.5", extendedPrice: "25", countryOfOrigin: "CN", hts10: "1111111111" },
      { row: 2, sku: "AB-200", description: "Hinge", quantity: "1000", unitPrice: "1.25", extendedPrice: "1250", countryOfOrigin: "CN", hts10: "2222222222" },
      { row: 3, sku: "ZZ-999", description: "Missing", quantity: "1", unitPrice: "1", extendedPrice: "1", countryOfOrigin: "CN", hts10: null },
    ],
  };
  const doc = normalizeDocument(cleanDoc());
  const lines: MatchedLine[] = doc.lines.map((l, i) => ({
    ...l,
    match: { status: "matched", hts10: ["1111111111", "2222222222", "3333333333"][i]!, htsSource: "catalog-matched", sheetRow: i + 2 },
  }));
  const report = (blockingRow: number | null): Report =>
    ({
      status: blockingRow === null ? "ready_for_approval" : "needs_review",
      extraction: { provider: "p", model: "m", pages: [{ page: 1, status: "extracted", error: null, latencyMs: 100, inputTokens: 10, outputTokens: 5 }] },
      checks: blockingRow === null ? [] : [{ ruleId: "line-math", ruleVersion: "1", severity: "blocking", outcome: "fail", row: blockingRow, page: 1, field: null, expected: null, actual: null, message: "" }],
    }) as unknown as Report;

  it("aligns by SKU and computes recall/precision inputs", () => {
    const s = scoreInvoice(gt, report(null), doc.header, lines);
    expect(s).toMatchObject({ expectedLines: 3, extractedLines: 3, alignedLines: 2, latencyMs: 100, inputTokens: 10 });
    expect(s.headerCorrect).toEqual({ invoiceNumber: true, currency: true, invoiceTotal: true });
    expect(s.fieldCorrect.quantity).toBe(2);
  });

  it("counts a wrong critical value as silent only when its row has no blocking finding", () => {
    const wrong = lines.map((l, i) => (i === 1 ? { ...l, countryOfOrigin: "VN" } : l));
    expect(scoreInvoice(gt, report(null), doc.header, wrong).silentErrors).toEqual([{ row: 2, field: "countryOfOrigin" }]);
    expect(scoreInvoice(gt, report(2), doc.header, wrong).silentErrors).toEqual([]);
  });

  it("counts a wrong currency or total on an unblocked document as silent", () => {
    const s = scoreInvoice({ ...gt, header: { ...gt.header, currency: "EUR" } }, report(null), doc.header, lines);
    expect(s.silentErrors).toContainEqual({ row: null, field: "currency" });
  });
});

describe("comparisonMarkdown", () => {
  it("renders one column per provider", () => {
    const md = comparisonMarkdown([]);
    expect(md.split("\n")[0]).toBe("| Metric |  |");
  });
});
