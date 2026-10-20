import { describe, expect, it } from "vitest";
import { buildReport, escapeFormula, normalizeDocument, toLinesCsv, type CheckResult, type MatchedLine, type ReportInput } from "../src/index.ts";
import { cleanDoc, line } from "./helpers.ts";

function matched(overrides: Parameters<typeof line>[0] = {}): MatchedLine[] {
  const doc = cleanDoc();
  doc.lines = [line(overrides)];
  return normalizeDocument(doc).lines.map((l) => ({ ...l, match: { status: "matched", hts10: "0101210010", htsSource: "catalog-matched", sheetRow: 2 } }));
}

const fail = (row: number, severity: "blocking" | "warning" = "blocking"): CheckResult => ({
  ruleId: "line-math", ruleVersion: "1", severity, outcome: "fail", row, page: 1, field: null, expected: null, actual: null, message: "",
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
    const csv = toLinesCsv(matched(), "USD", [fail(1), { ...fail(1, "warning"), ruleId: "required-fields" }]);
    expect(csv.split("\r\n")[1]).toMatch(/,needs_review,line-math;required-fields\(warning\)$/);
    const warnOnly = toLinesCsv(matched(), "USD", [fail(1, "warning")]);
    expect(warnOnly.split("\r\n")[1]).toMatch(/,ok,line-math\(warning\)$/);
  });
});

describe("buildReport", () => {
  const input = (checks: CheckResult[], pageStatus = "extracted"): ReportInput => ({
    input: { pdfFile: "a.pdf", pdfSha256: "x", pageCount: 1, skuSheetFile: "s.csv", skuSheetSha256: "y" },
    versions: {},
    extraction: { provider: "p", model: "m", pages: [{ page: 1, status: pageStatus, error: null, latencyMs: 1, inputTokens: null, outputTokens: null }] },
    lineCount: 2,
    matched: 1,
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
