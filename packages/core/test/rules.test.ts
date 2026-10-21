import { describe, expect, it } from "vitest";
import {
  duplicateLines,
  footerTotal,
  lineMath,
  normalizeDocument,
  pageContinuity,
  requiredFields,
  RULE_IDS,
  runRules,
  V0_RULES,
  weights,
  type CheckResult,
  type DocumentExtraction,
  type Rule,
} from "../src/index.ts";
import { cleanDoc, line } from "./helpers.ts";

function failures(rule: Rule, doc: DocumentExtraction): CheckResult[] {
  return rule.run(normalizeDocument(doc)).filter((c) => c.outcome === "fail");
}

function blockingFailures(rule: Rule, doc: DocumentExtraction): CheckResult[] {
  return failures(rule, doc).filter((c) => c.severity === "blocking");
}

describe("v0 rule set", () => {
  it("runs R1, R2, R3, R5, R6 and R7 in order (R4 runs against the SKU sheet)", () => {
    expect(V0_RULES.map((r) => r.id)).toEqual([
      "R1-line-math",
      "R2-footer-total",
      "R3-weights",
      "R5-required-fields",
      "R6-duplicate-lines",
      "R7-page-continuity",
    ]);
    expect(RULE_IDS.skuMatch).toBe("R4-sku-match");
  });

  it("passes a clean document with no failures", () => {
    const results = runRules(normalizeDocument(cleanDoc()));
    expect(results.filter((r) => r.outcome === "fail")).toEqual([]);
    for (const rule of V0_RULES) {
      expect(results.some((r) => r.ruleId === rule.id)).toBe(true);
    }
  });

  it("has no currency rule", () => {
    const doc = cleanDoc();
    doc.header.currency = null;
    expect(runRules(normalizeDocument(doc)).filter((r) => r.outcome === "fail")).toEqual([]);
  });

  it("is deterministic", () => {
    const a = runRules(normalizeDocument(cleanDoc()));
    const b = runRules(normalizeDocument(cleanDoc()));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("every result carries rule id, version, severity, row, page, expected and actual keys", () => {
    for (const r of runRules(normalizeDocument(cleanDoc()))) {
      expect(Object.keys(r).sort()).toEqual(
        ["actual", "expected", "field", "message", "outcome", "page", "row", "ruleId", "ruleVersion", "severity"].sort(),
      );
    }
  });
});

describe("R1 line math", () => {
  it("passes on a clean copy", () => {
    expect(failures(lineMath, cleanDoc())).toEqual([]);
  });

  it("fails when qty × price differs from the extended price by more than 0.01", () => {
    const doc = cleanDoc();
    doc.lines[1] = line({ rowOnPage: 2, sku: "AB-200", quantity: "1,000", unitPrice: "1.25", extendedPrice: "1,205.00" });
    const [f] = failures(lineMath, doc);
    expect(f).toMatchObject({ ruleId: "R1-line-math", severity: "blocking", row: 2, page: 1, expected: "1250", actual: "1205.00" });
  });

  it("allows a difference of exactly 0.01 and no more", () => {
    const doc = cleanDoc();
    doc.lines = [line({ quantity: "3", unitPrice: "0.335", extendedPrice: "1.00" })];
    expect(failures(lineMath, doc)).toEqual([]);
    doc.lines = [line({ quantity: "3", unitPrice: "0.335", extendedPrice: "1.015" })];
    expect(failures(lineMath, doc)).toEqual([]);
    doc.lines = [line({ quantity: "3", unitPrice: "0.335", extendedPrice: "0.99" })];
    expect(failures(lineMath, doc)).toHaveLength(1);
  });

  it("is exact where floats are not", () => {
    const doc = cleanDoc();
    doc.lines = [line({ quantity: "3", unitPrice: "0.10", extendedPrice: "0.30" })];
    const [r] = lineMath.run(normalizeDocument(doc));
    expect(r).toMatchObject({ outcome: "pass", expected: "0.3" });
  });

  it("skips lines without quantity or unit price, and fails a missing extended price", () => {
    const doc = cleanDoc();
    doc.lines[0] = line({ unitPrice: null });
    doc.lines[1] = line({ rowOnPage: 2, extendedPrice: null });
    const [a, b] = lineMath.run(normalizeDocument(doc));
    expect(a!.outcome).toBe("skipped");
    expect(b).toMatchObject({ outcome: "fail", severity: "blocking", row: 2, actual: null });
  });
});

describe("R2 footer total", () => {
  it("passes on a clean copy", () => {
    expect(failures(footerTotal, cleanDoc())).toEqual([]);
  });

  it("fails when lines don't sum to the total (omitted row)", () => {
    const doc = cleanDoc();
    doc.lines.pop();
    const [f] = failures(footerTotal, doc);
    expect(f).toMatchObject({ ruleId: "R2-footer-total", severity: "blocking", expected: "1275.00", actual: "1525.00" });
    expect(f!.message).toMatch(/difference 250\.00, tolerance 0\.02/);
  });

  it("tolerates 0.01 per line, and no more", () => {
    const doc = cleanDoc();
    doc.header.invoiceTotal = "$1,525.03";
    expect(failures(footerTotal, doc)).toEqual([]);
    doc.header.invoiceTotal = "$1,524.97";
    expect(failures(footerTotal, doc)).toEqual([]);
    doc.header.invoiceTotal = "$1,525.04";
    expect(failures(footerTotal, doc)).toHaveLength(1);
  });

  it("fails when the total is missing", () => {
    const doc = cleanDoc();
    doc.header.invoiceTotal = null;
    expect(blockingFailures(footerTotal, doc)).toHaveLength(1);
  });
});

describe("R3 weights", () => {
  it("passes on a clean copy", () => {
    const [r] = weights.run(normalizeDocument(cleanDoc()));
    expect(r).toMatchObject({ ruleId: "R3-weights", outcome: "pass", expected: "≤ 412.5 KG", actual: "380 KG" });
  });

  it("fails when net exceeds gross", () => {
    const doc = cleanDoc();
    doc.header.totalNetWeight = "425 KG";
    expect(blockingFailures(weights, doc)[0]).toMatchObject({ actual: "425 KG", field: "totalNetWeight" });
  });

  it("passes when net equals gross", () => {
    const doc = cleanDoc();
    doc.header.totalNetWeight = "412.50 kg";
    expect(failures(weights, doc)).toEqual([]);
  });

  it("converts between units exactly", () => {
    const doc = cleanDoc();
    doc.header.totalGrossWeight = "100 LB";
    doc.header.totalNetWeight = "45.359237 KG";
    expect(failures(weights, doc)).toEqual([]);
    doc.header.totalNetWeight = "45.36 KG";
    expect(blockingFailures(weights, doc)[0]).toMatchObject({ expected: "≤ 45.359237 KG", actual: "45.36 KG" });
  });

  it("fails when only one weight has a unit", () => {
    const doc = cleanDoc();
    doc.header.totalNetWeight = "380";
    expect(blockingFailures(weights, doc)[0]!.message).toMatch(/Only one of the weights has a unit/);
  });

  it("warns (does not block) when a weight is not printed", () => {
    const doc = cleanDoc();
    doc.header.totalGrossWeight = null;
    expect(blockingFailures(weights, doc)).toEqual([]);
    expect(failures(weights, doc)[0]).toMatchObject({ severity: "warning", actual: "no gross weight printed" });
  });

  it("skips when a printed weight could not be read (the parse finding blocks)", () => {
    const doc = cleanDoc();
    doc.header.totalNetWeight = "380 crates";
    expect(weights.run(normalizeDocument(doc))[0]!.outcome).toBe("skipped");
  });
});

describe("R5 required fields", () => {
  it("passes on a clean copy", () => {
    expect(failures(requiredFields, cleanDoc())).toEqual([]);
  });

  it("fails on missing SKU, quantity, unit price or origin, with row and page", () => {
    const doc = cleanDoc();
    doc.lines[2] = line({ page: 2, sku: null, quantity: "  ", countryOfOrigin: null });
    const [f, ...rest] = blockingFailures(requiredFields, doc);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ ruleId: "R5-required-fields", row: 3, page: 2, field: "sku,quantity,countryOfOrigin" });
  });

  it("does not require description or header fields", () => {
    const doc = cleanDoc();
    doc.lines[0] = line({ description: null });
    doc.header.invoiceNumber = null;
    expect(failures(requiredFields, doc)).toEqual([]);
  });
});

describe("R6 duplicate lines across a page break", () => {
  it("passes on a clean copy", () => {
    expect(failures(duplicateLines, cleanDoc())).toEqual([]);
  });

  it("warns when the first row of a page repeats the SKU and price of the previous page's last row", () => {
    const doc = cleanDoc();
    doc.lines[2] = line({ page: 2, sku: " ab-200", quantity: "5", unitPrice: "1.250", extendedPrice: "6.25" });
    const [f, ...rest] = failures(duplicateLines, doc);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ ruleId: "R6-duplicate-lines", severity: "warning", row: 3, page: 2, actual: "same SKU AB-200 and unit price as row 2 (page 1)" });
  });

  it("ignores repeats within a page, at a different price, or across a missing page", () => {
    const doc = cleanDoc();
    doc.lines[1] = line({ rowOnPage: 2 });
    doc.lines[2] = line({ page: 2, sku: "AB-100", unitPrice: "2.40", extendedPrice: "24.00" });
    expect(failures(duplicateLines, doc)).toEqual([]);
    doc.pageCount = 3;
    doc.lines[2] = line({ page: 3 });
    expect(failures(duplicateLines, doc)).toEqual([]);
  });
});

describe("R7 page continuity", () => {
  it("passes on a clean copy", () => {
    expect(failures(pageContinuity, cleanDoc())).toEqual([]);
  });

  it("fails on a failed page", () => {
    const doc = cleanDoc();
    doc.pages[1] = { page: 2, status: "failed", error: "schema validation failed" };
    const [f] = failures(pageContinuity, doc);
    expect(f).toMatchObject({ ruleId: "R7-page-continuity", severity: "blocking", page: 2, row: null });
    expect(f!.actual).toMatch(/schema validation failed/);
  });

  it("fails on a page with no extraction at all", () => {
    const doc = cleanDoc();
    doc.pageCount = 3;
    expect(failures(pageContinuity, doc)[0]).toMatchObject({ page: 3, actual: "no extraction for page" });
  });

  it("fails on an unmerged split row", () => {
    const doc = cleanDoc();
    doc.lines[1] = line({ rowOnPage: 2, sku: "AB-200", quantity: "1,000", unitPrice: "1.25", extendedPrice: "1,250.00", continuesOnNextPage: true });
    expect(failures(pageContinuity, doc)[0]).toMatchObject({ row: 2, page: 1, actual: "continues on next page, unmerged" });
  });

  it("fails on a line referencing a page beyond the document", () => {
    const doc = cleanDoc();
    doc.lines[2] = line({ page: 5 });
    expect(failures(pageContinuity, doc).some((f) => f.field === "page" && f.row === 3)).toBe(true);
  });
});
