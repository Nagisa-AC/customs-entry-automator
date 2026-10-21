import { describe, expect, it } from "vitest";
import { buildReport, countAdjustmentLines, escapeFormula, normalizeDocument, toLinesCsv, type CheckResult, type MatchedLine, type ReportInput } from "../src/index.ts";
import { cleanDoc, line } from "./helpers.ts";

function matched(overrides: Parameters<typeof line>[0] = {}): MatchedLine[] {
  const doc = cleanDoc();
  doc.lines = [line(overrides)];
  return normalizeDocument(doc).lines.map((l) => ({ ...l, match: { status: "matched", hts10: "0101210010", htsSource: "catalog-matched", sheetRow: 2 } }));
}

const fail = (row: number, severity: "blocking" | "warning" = "blocking"): CheckResult => ({
  ruleId: "R1-line-math", ruleVersion: "2", severity, outcome: "fail", row, page: 1, field: null, expected: null, actual: null, message: "",
});

describe("escapeFormula", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"])("escapes %j", (s) => {
    expect(escapeFormula(s)).toBe(`'${s}`);
  });
  it("leaves ordinary text alone", () => {
    expect(escapeFormula("Steel bracket")).toBe("Steel bracket");
  });
});

describe("toLinesCsv", () => {
  it("writes a header and one CRLF-terminated row per line, keeping HTS leading zeros and printed precision", () => {
    const csv = toLinesCsv(matched(), "USD", []);
    const [header, row, end] = csv.split("\r\n");
    expect(header).toBe("row,page,sku,description,quantity,unit_of_measure,unit_price,extended_price,currency,country_of_origin,hts10,hts_source,status,issues");
    expect(row).toBe("1,1,AB-100,Steel bracket,10,PCS,2.50,25.00,USD,CN,0101210010,catalog-matched,ok,");
    expect(end).toBe("");
  });

  it("escapes formula injection in text fields and quotes commas, quotes and newlines", () => {
    const csv = toLinesCsv(matched({ description: '=HYPERLINK("http://x","click"), more\nline', sku: "@ab" }), "USD", []);
    const row = csv.split("\r\n")[1]!;
    expect(row).toContain(`'@AB`);
    expect(row).toContain(`"'=HYPERLINK(""http://x"",""click""), more\nline"`);
  });

  it("marks rows with blocking failures as needs_review and lists issues", () => {
    const csv = toLinesCsv(matched(), "USD", [fail(1), { ...fail(1, "warning"), ruleId: "R6-duplicate-lines" }]);
    expect(csv.split("\r\n")[1]).toMatch(/,needs_review,R1-line-math;R6-duplicate-lines\(warning\)$/);
    const warnOnly = toLinesCsv(matched(), "USD", [fail(1, "warning")]);
    expect(warnOnly.split("\r\n")[1]).toMatch(/,ok,R1-line-math\(warning\)$/);
  });
});

describe("buildReport", () => {
  const input = (checks: CheckResult[], pageStatus = "extracted"): ReportInput => ({
    input: { pdfFile: "a.pdf", pdfSha256: "x", pageCount: 1, skuSheetFile: "s.csv", skuSheetSha256: "y" },
    versions: {},
    extraction: { provider: "p", model: "m", pages: [{ page: 1, status: pageStatus, error: null, latencyMs: 1, inputTokens: null, outputTokens: null }] },
    lineCount: 2,
    matched: 1,
    adjustments: { probableLines: [], r2Failed: false },
    checks,
  });

  it("is ready_for_approval only with no blocking failures", () => {
    expect(buildReport(input([fail(1, "warning")])).status).toBe("ready_for_approval");
    expect(buildReport(input([fail(1)])).status).toBe("needs_review");
    expect(buildReport(input([], "failed")).status).toBe("failed");
  });

  it("summarizes counts", () => {
    const r = buildReport(input([fail(1), fail(2, "warning"), { ...fail(1), outcome: "pass" }]));
    expect(r.summary).toEqual({ lines: 2, checks: 3, passed: 1, failed: 2, skipped: 0, blocking: 1, warnings: 1, catalogMatched: 1, catalogUnmatched: 1 });
  });
});

describe("countAdjustmentLines", () => {
  const r2 = (outcome: "pass" | "fail"): CheckResult => ({
    ruleId: "R2-footer-total", ruleVersion: "1", severity: "blocking", outcome, row: null, page: null, field: "invoiceTotal", expected: null, actual: null, message: "",
  });

  it("flags lines with adjustment terms or no SKU and records whether R2 failed", () => {
    const doc = cleanDoc();
    doc.lines.push(
      line({ page: 2, rowOnPage: 2, sku: null, description: "Ocean freight", quantity: "1", unitPrice: "80.00", extendedPrice: "80.00" }),
      line({ page: 2, rowOnPage: 3, sku: "DISC-5", description: "Early-payment discount 5%", quantity: "1", unitPrice: "(10.00)", extendedPrice: "(10.00)" }),
      line({ page: 2, rowOnPage: 4, sku: null, description: "Misc" }),
    );
    const result = countAdjustmentLines(normalizeDocument(doc).lines, [r2("fail")]);
    expect(result).toEqual({
      probableLines: [
        { row: 4, page: 2, reason: "adjustment-term", term: "freight" },
        { row: 5, page: 2, reason: "adjustment-term", term: "discount" },
        { row: 6, page: 2, reason: "no-sku", term: null },
      ],
      r2Failed: true,
    });
  });

  it("does not match terms inside other words, and reports R2 passing", () => {
    const doc = cleanDoc();
    doc.lines = [line({ description: "Coffee grinder, uncharged battery" })];
    expect(countAdjustmentLines(normalizeDocument(doc).lines, [r2("pass")])).toEqual({ probableLines: [], r2Failed: false });
  });
});
