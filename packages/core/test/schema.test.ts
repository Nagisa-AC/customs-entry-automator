import { describe, expect, it } from "vitest";
import { EXTRACTION_SCHEMA_VERSION, parsePageExtraction, type PageExtraction } from "../src/index.ts";

function validPage(): PageExtraction {
  return {
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    page: 1,
    header: {
      invoiceNumber: "INV-1001",
      invoiceDate: "2026-10-01",
      currency: "USD",
      sellerName: "Example Supplier Co.",
      buyerName: "Example Importer LLC",
      invoiceTotal: "1,234.50",
    },
    lines: [
      {
        page: 1,
        rowOnPage: 1,
        sku: " ab-100 ",
        description: "Widget",
        quantity: "10",
        unitOfMeasure: "PCS",
        unitPrice: "$12.345",
        extendedPrice: "123.45",
        countryOfOrigin: "CN",
        continuedFromPreviousPage: false,
        continuesOnNextPage: false,
        region: [0.05, 0.3, 0.95, 0.33],
      },
    ],
  };
}

describe("parsePageExtraction", () => {
  it("accepts a well-formed page", () => {
    const result = parsePageExtraction(validPage());
    expect(result.ok).toBe(true);
  });

  it("keeps numbers as the raw printed strings", () => {
    const result = parsePageExtraction(validPage());
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const line = result.value.lines[0]!;
    expect(line.unitPrice).toBe("$12.345");
    expect(line.sku).toBe(" ab-100 ");
    expect(result.value.header.invoiceTotal).toBe("1,234.50");
  });

  it("rejects numeric values instead of coercing them", () => {
    const page = validPage() as unknown as { lines: { quantity: unknown }[] };
    page.lines[0]!.quantity = 10;
    const result = parsePageExtraction(page);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("lines.0.quantity");
  });

  it("requires every field to be present (null when not visible)", () => {
    const page = validPage() as unknown as { lines: Record<string, unknown>[] };
    delete page.lines[0]!.countryOfOrigin;
    expect(parsePageExtraction(page).ok).toBe(false);

    const withNull = validPage();
    withNull.lines[0]!.countryOfOrigin = null;
    expect(parsePageExtraction(withNull).ok).toBe(true);
  });

  it("rejects unknown keys", () => {
    const page = { ...validPage(), confidence: 0.99 };
    const result = parsePageExtraction(page);
    expect(result.ok).toBe(false);
  });

  it("rejects a wrong schema version", () => {
    expect(parsePageExtraction({ ...validPage(), schemaVersion: "extraction-v0" }).ok).toBe(false);
  });

  it("requires a page number on every line that matches the page", () => {
    const page = validPage();
    page.lines[0]!.page = 2;
    const result = parsePageExtraction(page);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("lines.0.page");
  });

  it("rejects out-of-range source regions", () => {
    const page = validPage();
    page.lines[0]!.region = [0, 0, 1.5, 1];
    expect(parsePageExtraction(page).ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(parsePageExtraction("not json").ok).toBe(false);
    expect(parsePageExtraction(null).ok).toBe(false);
  });
});
