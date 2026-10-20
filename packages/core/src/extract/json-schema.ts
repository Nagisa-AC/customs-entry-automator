/**
 * JSON Schema handed to providers for structured output. Kept in the subset
 * that strict structured-output modes accept (every property required, no
 * tuples, no additional properties). The Zod schema remains the authority:
 * provider output is always re-validated with parsePageExtraction().
 */
const nullableString = { type: ["string", "null"] } as const;

const line = {
  type: "object",
  additionalProperties: false,
  required: [
    "page", "rowOnPage", "sku", "description", "quantity", "unitOfMeasure", "unitPrice",
    "extendedPrice", "countryOfOrigin", "continuedFromPreviousPage", "continuesOnNextPage", "region",
  ],
  properties: {
    page: { type: "integer" },
    rowOnPage: { type: "integer" },
    sku: nullableString,
    description: nullableString,
    quantity: nullableString,
    unitOfMeasure: nullableString,
    unitPrice: nullableString,
    extendedPrice: nullableString,
    countryOfOrigin: nullableString,
    continuedFromPreviousPage: { type: "boolean" },
    continuesOnNextPage: { type: "boolean" },
    region: { type: ["array", "null"], items: { type: "number" } },
  },
} as const;

const header = {
  type: "object",
  additionalProperties: false,
  required: ["invoiceNumber", "invoiceDate", "currency", "sellerName", "buyerName", "invoiceTotal"],
  properties: {
    invoiceNumber: nullableString,
    invoiceDate: nullableString,
    currency: nullableString,
    sellerName: nullableString,
    buyerName: nullableString,
    invoiceTotal: nullableString,
  },
} as const;

export const PAGE_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "page", "header", "lines"],
  properties: {
    schemaVersion: { type: "string", enum: ["extraction-v1"] },
    page: { type: "integer" },
    header,
    lines: { type: "array", items: line },
  },
} as const;
