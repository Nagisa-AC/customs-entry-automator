import type { CheckResult } from "../checks.ts";
import {
  EXTRACTION_SCHEMA_VERSION,
  HEADER_FIELDS,
  type DocumentExtraction,
  type ExtractedHeader,
  type ExtractedLine,
  type PageStatus,
} from "../schema.ts";
import type { PageOutcome } from "./extract.ts";

export const STITCHER_VERSION = "stitch-v1";

const VALUE_FIELDS = ["sku", "quantity", "unitOfMeasure", "unitPrice", "extendedPrice", "countryOfOrigin"] as const;

export interface StitchResult {
  document: DocumentExtraction;
  findings: CheckResult[];
}

function finding(init: Omit<CheckResult, "ruleVersion">): CheckResult {
  return { ...init, ruleVersion: "1" };
}

/** Two halves are complementary when no value field is printed on both. */
function complementary(head: ExtractedLine, tail: ExtractedLine): boolean {
  return VALUE_FIELDS.every((f) => head[f] === null || tail[f] === null);
}

function mergeSplit(head: ExtractedLine, tail: ExtractedLine): ExtractedLine {
  const pick = <K extends (typeof VALUE_FIELDS)[number]>(f: K) => head[f] ?? tail[f];
  const description = [head.description, tail.description].filter((d): d is string => d !== null && d.trim() !== "").join(" ");
  return {
    ...head,
    sku: pick("sku"),
    description: description === "" ? null : description,
    quantity: pick("quantity"),
    unitOfMeasure: pick("unitOfMeasure"),
    unitPrice: pick("unitPrice"),
    extendedPrice: pick("extendedPrice"),
    countryOfOrigin: pick("countryOfOrigin"),
    continuedFromPreviousPage: head.continuedFromPreviousPage,
    continuesOnNextPage: tail.continuesOnNextPage,
  };
}

/**
 * Merge per-page extractions into one document, in page order. Rows split
 * across a page break are merged only when the halves are complementary;
 * nothing is dropped, and every merge is reported. Rows repeated across a
 * page break are kept as-is and left for R6.
 */
export function stitch(outcomes: readonly PageOutcome[], pageCount: number): StitchResult {
  const sorted = [...outcomes].sort((a, b) => a.page - b.page);
  const findings: CheckResult[] = [];
  const pages: PageStatus[] = sorted.map((o) => ({ page: o.page, status: o.status, error: o.error }));

  const header = Object.fromEntries(HEADER_FIELDS.map((f) => [f, null])) as ExtractedHeader;
  const headerSource = new Map<keyof ExtractedHeader, number>();
  for (const o of sorted) {
    if (!o.extraction) continue;
    for (const f of HEADER_FIELDS) {
      const v = o.extraction.header[f];
      if (v === null) continue;
      const current = header[f];
      if (current === null) {
        header[f] = v;
        headerSource.set(f, o.page);
      } else if (current.trim() !== v.trim()) {
        findings.push(
          finding({
            ruleId: "stitch-header-conflict",
            severity: "blocking",
            outcome: "fail",
            row: null,
            page: o.page,
            field: f,
            expected: current,
            actual: v,
            message: `Header ${f} differs between page ${headerSource.get(f)} and page ${o.page}; kept the page ${headerSource.get(f)} value. Confirm which is correct.`,
          }),
        );
      }
    }
  }

  const lines: ExtractedLine[] = [];
  let prevPage: number | null = null;
  for (const o of sorted) {
    if (!o.extraction) {
      prevPage = null;
      continue;
    }
    const pageLines = [...o.extraction.lines];
    const head = lines.at(-1);
    const tail = pageLines[0];
    const adjacent = prevPage !== null && prevPage === o.page - 1;
    if (adjacent && head && tail) {
      const flagged = head.continuesOnNextPage || tail.continuedFromPreviousPage;
      const bothFlagged = head.continuesOnNextPage && tail.continuedFromPreviousPage;
      if (flagged && complementary(head, tail)) {
        lines[lines.length - 1] = mergeSplit(head, tail);
        pageLines.shift();
        findings.push(
          finding({
            ruleId: "stitch-split-row",
            severity: "warning",
            outcome: bothFlagged ? "pass" : "fail",
            row: lines.length,
            page: head.page,
            field: null,
            expected: "row split across pages merged",
            actual: `merged page ${head.page} row ${head.rowOnPage} with page ${tail.page} row ${tail.rowOnPage}`,
            message: bothFlagged
              ? `Row split across pages ${head.page}-${tail.page} was merged.`
              : `Row split across pages ${head.page}-${tail.page} was merged although only one side was marked as continued. Verify against the source.`,
          }),
        );
      }
    }
    lines.push(...pageLines);
    prevPage = o.page;
  }

  return {
    document: { schemaVersion: EXTRACTION_SCHEMA_VERSION, pageCount, pages, header, lines },
    findings,
  };
}
