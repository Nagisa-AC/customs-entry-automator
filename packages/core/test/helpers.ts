import { EXTRACTION_SCHEMA_VERSION, type DocumentExtraction, type ExtractedLine } from "../src/index.ts";

export function line(overrides: Partial<ExtractedLine> = {}): ExtractedLine {
  return {
    page: 1,
    rowOnPage: 1,
    sku: "ab-100",
    description: "Steel bracket",
    quantity: "10",
    unitOfMeasure: "pcs",
    unitPrice: "2.50",
    extendedPrice: "25.00",
    countryOfOrigin: "cn",
    continuedFromPreviousPage: false,
    continuesOnNextPage: false,
    region: null,
    ...overrides,
  };
}

/** A clean two-page, three-line invoice that passes every v0 rule. */
export function cleanDoc(): DocumentExtraction {
  return {
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    pageCount: 2,
    pages: [
      { page: 1, status: "extracted", error: null },
      { page: 2, status: "extracted", error: null },
    ],
    header: {
      invoiceNumber: "INV-1001",
      invoiceDate: "2026-10-01",
      currency: "USD",
      sellerName: "Example Supplier Co.",
      buyerName: "Example Importer LLC",
      incoterms: "FOB Ningbo",
      invoiceTotal: "$1,525.00",
      totalGrossWeight: "412.5 KG",
      totalNetWeight: "380 KG",
    },
    lines: [
      line(),
      line({ rowOnPage: 2, sku: "AB-200", description: "Hinge", quantity: "1,000", unitPrice: "1.25", extendedPrice: "1,250.00" }),
      line({ page: 2, sku: "CD-300", description: "Gasket", quantity: "100", unitPrice: "2.50", extendedPrice: "250.00" }),
    ],
  };
}
