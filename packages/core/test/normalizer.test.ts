import { describe, expect, it } from "vitest";
import { normalizeDocument, normalizeSku } from "../src/index.ts";
import { cleanDoc, line } from "./helpers.ts";

describe("normalizeSku", () => {
  it("trims and uppercases", () => {
    expect(normalizeSku("  ab-100x ")).toBe("AB-100X");
  });
  it("treats blank as missing", () => {
    expect(normalizeSku("   ")).toBeNull();
    expect(normalizeSku(null)).toBeNull();
  });
});

describe("normalizeDocument", () => {
  it("parses a US-format document and keeps source strings", () => {
    const n = normalizeDocument(cleanDoc());
    expect(n.decimalFormat).toBe("dot");
    expect(n.header.invoiceTotal).toEqual({ raw: "$1,525.00", value: "1525", scale: 2 });
    const second = n.lines[1]!;
    expect(second.row).toBe(2);
    expect(second.quantity?.value).toBe("1000");
    expect(second.extendedPrice?.raw).toBe("1,250.00");
    expect(second.source.extendedPrice).toBe("1,250.00");
    expect(n.lines[0]!.sku).toBe("AB-100");
    expect(n.lines[0]!.countryOfOrigin).toBe("CN");
    expect(n.findings.filter((f) => f.outcome === "fail")).toEqual([]);
  });

  it("detects the decimal format once for a European document", () => {
    const doc = cleanDoc();
    doc.header.invoiceTotal = "1.525,00 EUR";
    doc.header.currency = "EUR";
    doc.header.totalGrossWeight = "412,5 kg";
    doc.lines = [
      line({ quantity: "10", unitPrice: "2,50", extendedPrice: "25,00" }),
      line({ rowOnPage: 2, sku: "AB-200", quantity: "1.000", unitPrice: "1,25", extendedPrice: "1.250,00" }),
      line({ page: 2, sku: "CD-300", quantity: "100", unitPrice: "2,50", extendedPrice: "250,00" }),
    ];
    const n = normalizeDocument(doc);
    expect(n.decimalFormat).toBe("comma");
    expect(n.lines.map((l) => l.quantity?.value)).toEqual(["10", "1000", "100"]);
    expect(n.header.invoiceTotal?.value).toBe("1525");
    expect(n.header.totalGrossWeight).toEqual({ raw: "412,5 kg", value: "412.5", scale: 1, unit: "KG" });
  });

  it("reports an unknown format as a blocking finding", () => {
    const doc = cleanDoc();
    doc.header.invoiceTotal = "1,525";
    doc.header.totalGrossWeight = null;
    doc.header.totalNetWeight = null;
    doc.lines = [line({ quantity: "1", unitPrice: "1,525", extendedPrice: "1,525" })];
    const n = normalizeDocument(doc);
    expect(n.decimalFormat).toBeNull();
    const fmt = n.findings.find((f) => f.ruleId === "decimal-format");
    expect(fmt?.outcome).toBe("fail");
    expect(fmt?.severity).toBe("blocking");
    expect(n.lines[0]!.unitPrice).toBeNull();
  });

  it("reports unparseable values with row, page and raw value", () => {
    const doc = cleanDoc();
    doc.lines[2] = line({ page: 2, unitPrice: "see attached" });
    const n = normalizeDocument(doc);
    const f = n.findings.find((x) => x.ruleId === "parse-number");
    expect(f).toMatchObject({ outcome: "fail", severity: "blocking", row: 3, page: 2, field: "unitPrice", actual: "see attached" });
    expect(n.lines[2]!.unitPrice).toBeNull();
  });

  it("treats null and blank fields as missing without findings", () => {
    const doc = cleanDoc();
    doc.lines[0] = line({ countryOfOrigin: null, unitOfMeasure: "  " });
    const n = normalizeDocument(doc);
    expect(n.lines[0]!.countryOfOrigin).toBeNull();
    expect(n.lines[0]!.unitOfMeasure).toBeNull();
    expect(n.findings.filter((f) => f.ruleId === "parse-number")).toEqual([]);
  });

  it("parses weights with their unit and counts them toward the decimal format", () => {
    const doc = cleanDoc();
    doc.header.totalGrossWeight = "2,760 LBS.";
    doc.header.totalNetWeight = "1250.5kg";
    const n = normalizeDocument(doc);
    expect(n.header.totalGrossWeight).toEqual({ raw: "2,760 LBS.", value: "2760", scale: 0, unit: "LB" });
    expect(n.header.totalNetWeight).toMatchObject({ value: "1250.5", unit: "KG" });
    expect(n.header.incoterms).toBe("FOB Ningbo");
  });

  it("keeps a unitless weight and reports an unknown unit as blocking", () => {
    const doc = cleanDoc();
    doc.header.totalGrossWeight = "412.5";
    doc.header.totalNetWeight = "380 cartons";
    const n = normalizeDocument(doc);
    expect(n.header.totalGrossWeight).toMatchObject({ value: "412.5", unit: null });
    expect(n.header.totalNetWeight).toBeNull();
    expect(n.findings.find((f) => f.ruleId === "parse-weight")).toMatchObject({ severity: "blocking", field: "totalNetWeight", actual: "380 cartons" });
  });
});
