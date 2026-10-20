import { describe, expect, it } from "vitest";
import {
  currency,
  duplicateLines,
  invoiceTotal,
  lineMath,
  normalizeDocument,
  pageContinuity,
  requiredFields,
  runRules,
  V0_RULES,
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
  it("has six rules with unique ids", () => {
    expect(V0_RULES).toHaveLength(6);
    expect(new Set(V0_RULES.map((r) => r.id)).size).toBe(6);
  });

  it("passes a clean document with no failures", () => {
    const results = runRules(normalizeDocument(cleanDoc()));
    expect(results.filter((r) => r.outcome === "fail")).toEqual([]);
    for (const rule of V0_RULES) {
      expect(results.some((r) => r.ruleId === rule.id)).toBe(true);
    }
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

describe("required-fields", () => {
  it("passes on a clean copy", () => {
    expect(failures(requiredFields, cleanDoc())).toEqual([]);
  });

  it("fires on a missing line field with row and page", () => {
    const doc = cleanDoc();
    doc.lines[2] = line({ page: 2, sku: null, quantity: "  " });
    const [f, ...rest] = blockingFailures(requiredFields, doc);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ row: 3, page: 2, field: "sku,quantity", actual: "missing: sku,quantity" });
  });

  it("fires on a missing header field", () => {
    const doc = cleanDoc();
    doc.header.invoiceNumber = null;
    expect(blockingFailures(requiredFields, doc)[0]).toMatchObject({ row: null, field: "invoiceNumber" });
  });

  it("warns (not blocks) on missing country of origin", () => {
    const doc = cleanDoc();
    doc.lines[0] = line({ countryOfOrigin: null });
    expect(blockingFailures(requiredFields, doc)).toEqual([]);
    expect(failures(requiredFields, doc)[0]).toMatchObject({ severity: "warning", row: 1, field: "countryOfOrigin" });
  });
});

describe("line-math", () => {
  it("passes on a clean copy", () => {
    expect(failures(lineMath, cleanDoc())).toEqual([]);
  });

  it("fires when qty × price differs from the extended price", () => {
    const doc = cleanDoc();
    doc.lines[1] = line({ rowOnPage: 2, sku: "AB-200", quantity: "1,000", unitPrice: "1.25", extendedPrice: "1,205.00" });
    const [f] = failures(lineMath, doc);
    expect(f).toMatchObject({ ruleId: "line-math", severity: "blocking", row: 2, page: 1, expected: "1250.00", actual: "1205.00" });
  });

  it("rounds half-up to the printed precision", () => {
    const doc = cleanDoc();
    doc.lines = [line({ quantity: "3", unitPrice: "0.335", extendedPrice: "1.01" })];
    expect(failures(lineMath, doc)).toEqual([]);
    doc.lines = [line({ quantity: "3", unitPrice: "0.335", extendedPrice: "1.00" })];
    expect(failures(lineMath, doc)).toHaveLength(1);
  });

  it("is exact where floats are not", () => {
    const doc = cleanDoc();
    doc.lines = [line({ quantity: "3", unitPrice: "0.10", extendedPrice: "0.30" })];
    expect(failures(lineMath, doc)).toEqual([]);
  });

  it("skips (does not pass) lines with missing inputs", () => {
    const doc = cleanDoc();
    doc.lines[0] = line({ unitPrice: null });
    const r = lineMath.run(normalizeDocument(doc))[0]!;
    expect(r.outcome).toBe("skipped");
  });
});

describe("invoice-total", () => {
  it("passes on a clean copy", () => {
    expect(failures(invoiceTotal, cleanDoc())).toEqual([]);
  });

  it("fires when lines don't sum to the total (omitted row)", () => {
    const doc = cleanDoc();
    doc.lines.pop();
    const [f] = failures(invoiceTotal, doc);
    expect(f).toMatchObject({ severity: "blocking", expected: "1275.00", actual: "1525.00" });
    expect(f!.message).toMatch(/difference 250\.00/);
  });

  it("fires when the total is missing", () => {
    const doc = cleanDoc();
    doc.header.invoiceTotal = null;
    expect(failures(invoiceTotal, doc)).toHaveLength(1);
  });
});

describe("duplicate-lines", () => {
  it("passes on a clean copy", () => {
    expect(failures(duplicateLines, cleanDoc())).toEqual([]);
  });

  it("fires on an exactly repeated line, pointing at the original", () => {
    const doc = cleanDoc();
    doc.lines.push(line({ page: 2, rowOnPage: 2, sku: " cd-300", description: "Gasket", quantity: "100", unitPrice: "2.50", extendedPrice: "250.00" }));
    const [f] = failures(duplicateLines, doc);
    expect(f).toMatchObject({ severity: "blocking", row: 4, page: 2, actual: "duplicate of row 3 (page 2)" });
  });

  it("does not flag same SKU at a different quantity", () => {
    const doc = cleanDoc();
    doc.lines.push(line({ page: 2, rowOnPage: 2, sku: "CD-300", description: "Gasket", quantity: "50", unitPrice: "2.50", extendedPrice: "125.00" }));
    expect(failures(duplicateLines, doc)).toEqual([]);
  });
});

describe("page-continuity", () => {
  it("passes on a clean copy", () => {
    expect(failures(pageContinuity, cleanDoc())).toEqual([]);
  });

  it("fires on a failed page", () => {
    const doc = cleanDoc();
    doc.pages[1] = { page: 2, status: "failed", error: "schema validation failed" };
    const [f] = failures(pageContinuity, doc);
    expect(f).toMatchObject({ severity: "blocking", page: 2, row: null });
    expect(f!.actual).toMatch(/schema validation failed/);
  });

  it("fires on a page with no extraction at all", () => {
    const doc = cleanDoc();
    doc.pageCount = 3;
    expect(failures(pageContinuity, doc)[0]).toMatchObject({ page: 3, actual: "no extraction for page" });
  });

  it("fires on an unmerged split row", () => {
    const doc = cleanDoc();
    doc.lines[1] = line({ rowOnPage: 2, sku: "AB-200", quantity: "1,000", unitPrice: "1.25", extendedPrice: "1,250.00", continuesOnNextPage: true });
    expect(failures(pageContinuity, doc)[0]).toMatchObject({ row: 2, page: 1, actual: "continues on next page, unmerged" });
  });

  it("fires on a line referencing a page beyond the document", () => {
    const doc = cleanDoc();
    doc.lines[2] = line({ page: 5 });
    expect(failures(pageContinuity, doc).some((f) => f.field === "page" && f.row === 3)).toBe(true);
  });
});

describe("currency", () => {
  it("passes on a clean copy", () => {
    expect(failures(currency, cleanDoc())).toEqual([]);
  });

  it("fires on a missing currency", () => {
    const doc = cleanDoc();
    doc.header.currency = null;
    expect(failures(currency, doc)[0]).toMatchObject({ severity: "blocking", field: "currency", actual: null });
  });

  it("fires on a symbol or unsupported code", () => {
    const doc = cleanDoc();
    doc.header.currency = "$";
    expect(failures(currency, doc)).toHaveLength(1);
    doc.header.currency = "XYZ";
    expect(failures(currency, doc)).toHaveLength(1);
  });

  it("accepts a lowercase supported code after normalization", () => {
    const doc = cleanDoc();
    doc.header.currency = " eur ";
    expect(failures(currency, doc)).toEqual([]);
  });
});
