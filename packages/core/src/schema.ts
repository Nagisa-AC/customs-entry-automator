import { z } from "zod";

/**
 * Extraction schema: what a model provider is allowed to return for one page.
 *
 * Every numeric value is the raw string exactly as printed on the page
 * ("1.234,50", "$12.00", "(3.00)"). Parsing happens later in the normalizer,
 * once the document's decimal format is known; the model never does math.
 * A field the model cannot see is `null`, never omitted and never guessed.
 */
export const EXTRACTION_SCHEMA_VERSION = "extraction-v1" as const;

/** A value as printed on the source page. Never coerced to a number here. */
export const RawText = z.string();
export type RawText = z.infer<typeof RawText>;

/** Nullable raw printed string: `null` means "not present on this page". */
export const RawField = RawText.nullable();

/** Source region as fractions of the page box: [x0, y0, x1, y1] in 0..1. */
export const SourceRegion = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(([x0, y0, x1, y1]) => [x0, y0, x1, y1].every((v) => v >= 0 && v <= 1) && x0 <= x1 && y0 <= y1, {
    message: "region must be [x0, y0, x1, y1] fractions with x0<=x1, y0<=y1",
  });
export type SourceRegion = z.infer<typeof SourceRegion>;

const PageNumber = z.number().int().min(1);

export const ExtractedLine = z
  .object({
    /** 1-based page the row was read from. */
    page: PageNumber,
    /** 1-based position of the row on its page, top to bottom. */
    rowOnPage: z.number().int().min(1),
    sku: RawField,
    description: RawField,
    quantity: RawField,
    unitOfMeasure: RawField,
    unitPrice: RawField,
    extendedPrice: RawField,
    countryOfOrigin: RawField,
    /** Row visibly continues from the previous page (top of page, partial). */
    continuedFromPreviousPage: z.boolean(),
    /** Row visibly continues onto the next page (bottom of page, partial). */
    continuesOnNextPage: z.boolean(),
    region: SourceRegion.nullable(),
  })
  .strict();
export type ExtractedLine = z.infer<typeof ExtractedLine>;

export const ExtractedHeader = z
  .object({
    invoiceNumber: RawField,
    invoiceDate: RawField,
    currency: RawField,
    sellerName: RawField,
    buyerName: RawField,
    incoterms: RawField,
    invoiceTotal: RawField,
    /** As printed, with its unit ("1.250,5 kg", "2,760 LBS"). */
    totalGrossWeight: RawField,
    totalNetWeight: RawField,
  })
  .strict();
export type ExtractedHeader = z.infer<typeof ExtractedHeader>;

export const HEADER_FIELDS = Object.keys(ExtractedHeader.shape) as (keyof ExtractedHeader)[];

/** The structured output a provider must return for a single page. */
export const PageExtraction = z
  .object({
    schemaVersion: z.literal(EXTRACTION_SCHEMA_VERSION),
    page: PageNumber,
    header: ExtractedHeader,
    lines: z.array(ExtractedLine),
  })
  .strict()
  .superRefine((value, ctx) => {
    value.lines.forEach((line, i) => {
      if (line.page !== value.page) {
        ctx.addIssue({
          code: "custom",
          path: ["lines", i, "page"],
          message: `line page ${line.page} does not match extraction page ${value.page}`,
        });
      }
    });
  });
export type PageExtraction = z.infer<typeof PageExtraction>;

/** One invoice after pages are stitched: a single header and an ordered line list. */
export const DocumentExtraction = z
  .object({
    schemaVersion: z.literal(EXTRACTION_SCHEMA_VERSION),
    pageCount: z.number().int().min(1),
    header: ExtractedHeader,
    lines: z.array(ExtractedLine),
  })
  .strict();
export type DocumentExtraction = z.infer<typeof DocumentExtraction>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * Structural validation of untrusted provider output. Malformed output is
 * rejected with readable paths; nothing is coerced or defaulted.
 */
export function parsePageExtraction(input: unknown): ParseResult<PageExtraction> {
  const result = PageExtraction.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
  };
}
