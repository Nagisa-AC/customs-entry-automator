import type { CheckResult } from "./checks.ts";
import { detectDecimalFormat, parseNumber, type DecimalFormat } from "./decimal-format.ts";
import type { DocumentExtraction, ExtractedHeader, ExtractedLine, PageStatus, SourceRegion } from "./schema.ts";

export const NORMALIZER_VERSION = "normalizer-v1";

/** A parsed number that keeps its source string. `value` is a canonical decimal string. */
export interface Amount {
  raw: string;
  value: string;
  scale: number;
}

export interface NormalizedHeader {
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string | null;
  sellerName: string | null;
  buyerName: string | null;
  invoiceTotal: Amount | null;
}

export interface NormalizedLine {
  /** 1-based position in the stitched line list. */
  row: number;
  page: number;
  rowOnPage: number;
  sku: string | null;
  description: string | null;
  quantity: Amount | null;
  unitOfMeasure: string | null;
  unitPrice: Amount | null;
  extendedPrice: Amount | null;
  countryOfOrigin: string | null;
  continuedFromPreviousPage: boolean;
  continuesOnNextPage: boolean;
  region: SourceRegion | null;
  source: ExtractedLine;
}

export interface NormalizedDocument {
  schemaVersion: DocumentExtraction["schemaVersion"];
  normalizerVersion: typeof NORMALIZER_VERSION;
  pageCount: number;
  pages: PageStatus[];
  decimalFormat: DecimalFormat | null;
  header: NormalizedHeader;
  rawHeader: ExtractedHeader;
  lines: NormalizedLine[];
  /** Normalization findings (format detection and unparseable values). */
  findings: CheckResult[];
}

function text(raw: string | null): string | null {
  if (raw === null) return null;
  const t = raw.trim();
  return t === "" ? null : t;
}

/** SKUs are trimmed and uppercased; nothing else about them is changed. */
export function normalizeSku(raw: string | null): string | null {
  const t = text(raw);
  return t === null ? null : t.toUpperCase();
}

function collectNumericRaws(doc: DocumentExtraction): string[] {
  const raws: string[] = [];
  const push = (v: string | null) => {
    if (text(v) !== null) raws.push(v as string);
  };
  push(doc.header.invoiceTotal);
  for (const line of doc.lines) {
    push(line.quantity);
    push(line.unitPrice);
    push(line.extendedPrice);
  }
  return raws;
}

export function normalizeDocument(doc: DocumentExtraction): NormalizedDocument {
  const findings: CheckResult[] = [];
  const detection = detectDecimalFormat(collectNumericRaws(doc));
  const format = detection.format;
  findings.push({
    ruleId: "decimal-format",
    ruleVersion: "1",
    severity: "blocking",
    outcome: format ? "pass" : "fail",
    row: null,
    page: null,
    field: null,
    expected: "one consistent decimal format",
    actual: format ?? `unknown (dot=${detection.dotVotes}, comma=${detection.commaVotes}, ambiguous=${detection.ambiguous})`,
    message: format
      ? `Decimal format detected once for the document: ${detection.reason}.`
      : `Could not determine the decimal format: ${detection.reason}. Confirm the format manually.`,
  });

  const amount = (
    raw: string | null,
    field: string,
    allowCurrency: boolean,
    where: { row: number | null; page: number | null },
  ): Amount | null => {
    const t = text(raw);
    if (t === null) return null;
    const result = parseNumber(t, format, allowCurrency);
    if (result.ok) {
      return { raw: t, value: result.parsed.value.toFixed(), scale: result.parsed.scale };
    }
    findings.push({
      ruleId: "parse-number",
      ruleVersion: "1",
      severity: "blocking",
      outcome: "fail",
      row: where.row,
      page: where.page,
      field,
      expected: format ? `${format}-decimal number` : "number",
      actual: t,
      message: `Value could not be read as a number (${result.reason}). Check the source and correct it.`,
    });
    return null;
  };

  const header: NormalizedHeader = {
    invoiceNumber: text(doc.header.invoiceNumber),
    invoiceDate: text(doc.header.invoiceDate),
    currency: text(doc.header.currency)?.toUpperCase() ?? null,
    sellerName: text(doc.header.sellerName),
    buyerName: text(doc.header.buyerName),
    invoiceTotal: amount(doc.header.invoiceTotal, "invoiceTotal", true, { row: null, page: null }),
  };

  const lines = doc.lines.map((line, i): NormalizedLine => {
    const where = { row: i + 1, page: line.page };
    return {
      row: i + 1,
      page: line.page,
      rowOnPage: line.rowOnPage,
      sku: normalizeSku(line.sku),
      description: text(line.description),
      quantity: amount(line.quantity, "quantity", false, where),
      unitOfMeasure: text(line.unitOfMeasure)?.toUpperCase() ?? null,
      unitPrice: amount(line.unitPrice, "unitPrice", true, where),
      extendedPrice: amount(line.extendedPrice, "extendedPrice", true, where),
      countryOfOrigin: text(line.countryOfOrigin)?.toUpperCase() ?? null,
      continuedFromPreviousPage: line.continuedFromPreviousPage,
      continuesOnNextPage: line.continuesOnNextPage,
      region: line.region,
      source: line,
    };
  });

  return {
    schemaVersion: doc.schemaVersion,
    normalizerVersion: NORMALIZER_VERSION,
    pageCount: doc.pageCount,
    pages: doc.pages,
    decimalFormat: format,
    header,
    rawHeader: doc.header,
    lines,
    findings,
  };
}
