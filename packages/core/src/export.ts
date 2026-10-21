import Decimal from "decimal.js";
import type { MatchedLine } from "./catalog.ts";
import { isBlockingFailure, type CheckResult } from "./checks.ts";
import type { Amount, NormalizedLine } from "./normalizer.ts";
import { RULE_IDS } from "./rules.ts";

export const EXPORTER_VERSION = "generic-csv-v1";
export const REPORT_VERSION = "report-v2";

const ADJUSTMENT_TERM = /\b(freight|shipping|discount|rebate|insurance|surcharge|fees?|charges?)\b/i;

/**
 * Heuristic count of lines that look like freight, discount or other
 * adjustments, which M1 doesn't support and which make R2 fail. Not a rule:
 * it never changes status or blocks anything.
 */
export interface AdjustmentLines {
  probableLines: { row: number; page: number; reason: "no-sku" | "adjustment-term"; term: string | null }[];
  r2Failed: boolean;
}

export function countAdjustmentLines(lines: readonly NormalizedLine[], checks: readonly CheckResult[]): AdjustmentLines {
  const probableLines = lines.flatMap((l): AdjustmentLines["probableLines"] => {
    const term = l.description ? (ADJUSTMENT_TERM.exec(l.description)?.[1]?.toLowerCase() ?? null) : null;
    if (term) return [{ row: l.row, page: l.page, reason: "adjustment-term", term }];
    if (l.sku === null) return [{ row: l.row, page: l.page, reason: "no-sku", term: null }];
    return [];
  });
  const r2Failed = checks.some((c) => c.ruleId === RULE_IDS.footerTotal && c.outcome === "fail");
  return { probableLines, r2Failed };
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** Text cells starting with = + - @ (or tab/CR) are prefixed with ' so spreadsheets don't run them. */
export function escapeFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

function quote(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

const text = (v: string | null) => (v === null ? "" : escapeFormula(v));
const num = (v: Amount | null) => (v === null ? "" : new Decimal(v.value).toFixed(v.scale));

export const CSV_COLUMNS = [
  "row", "page", "sku", "description", "quantity", "unit_of_measure", "unit_price", "extended_price",
  "currency", "country_of_origin", "hts10", "hts_source", "status", "issues",
] as const;

/**
 * Generic CSV, one row per line. A development artifact, not a filing-system
 * import format. RFC 4180 quoting, CRLF, UTF-8. Numbers are plain decimals
 * (dot mark, no grouping) at their printed precision.
 * `status` is needs_review when the row has any blocking failure.
 */
export function toLinesCsv(lines: readonly MatchedLine[], currency: string | null, checks: readonly CheckResult[]): string {
  const issuesByRow = new Map<number, Set<string>>();
  for (const c of checks) {
    if (c.outcome !== "fail" || c.row === null) continue;
    issuesByRow.set(c.row, (issuesByRow.get(c.row) ?? new Set()).add(`${c.ruleId}${c.severity === "warning" ? "(warning)" : ""}`));
  }
  const blockingRows = new Set(checks.filter(isBlockingFailure).map((c) => c.row));
  const rows = lines.map((l) =>
    [
      String(l.row),
      String(l.page),
      text(l.sku),
      text(l.description),
      num(l.quantity),
      text(l.unitOfMeasure),
      num(l.unitPrice),
      num(l.extendedPrice),
      text(currency),
      text(l.countryOfOrigin),
      l.match.hts10 ?? "",
      l.match.htsSource ?? "",
      blockingRows.has(l.row) ? "needs_review" : "ok",
      [...(issuesByRow.get(l.row) ?? [])].join(";"),
    ].map(quote).join(","),
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}

export type DocumentStatus = "ready_for_approval" | "needs_review" | "failed";

export interface ReportInput {
  input: { pdfFile: string; pdfSha256: string; pageCount: number; skuSheetFile: string; skuSheetSha256: string };
  versions: Record<string, string>;
  extraction: {
    provider: string;
    model: string;
    pages: { page: number; status: string; error: string | null; latencyMs: number | null; inputTokens: number | null; outputTokens: number | null }[];
  };
  lineCount: number;
  matched: number;
  adjustments: AdjustmentLines;
  checks: CheckResult[];
}

export interface Report extends ReportInput {
  reportVersion: typeof REPORT_VERSION;
  status: DocumentStatus;
  summary: {
    lines: number;
    checks: number;
    passed: number;
    failed: number;
    skipped: number;
    blocking: number;
    warnings: number;
    catalogMatched: number;
    catalogUnmatched: number;
  };
}

/**
 * Every check from every stage, with row and page. Deterministic: no
 * timestamps or absolute paths, so cached re-runs produce identical bytes.
 */
export function buildReport(input: ReportInput): Report {
  const failed = input.checks.filter((c) => c.outcome === "fail");
  const blocking = failed.filter((c) => c.severity === "blocking").length;
  const extractedAny = input.extraction.pages.some((p) => p.status === "extracted");
  return {
    reportVersion: REPORT_VERSION,
    status: !extractedAny ? "failed" : blocking > 0 ? "needs_review" : "ready_for_approval",
    summary: {
      lines: input.lineCount,
      checks: input.checks.length,
      passed: input.checks.filter((c) => c.outcome === "pass").length,
      failed: failed.length,
      skipped: input.checks.filter((c) => c.outcome === "skipped").length,
      blocking,
      warnings: failed.length - blocking,
      catalogMatched: input.matched,
      catalogUnmatched: input.lineCount - input.matched,
    },
    ...input,
  };
}
