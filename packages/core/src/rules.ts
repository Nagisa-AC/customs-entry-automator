import Decimal from "decimal.js";
import type { CheckResult, Severity } from "./checks.ts";
import type { Amount, NormalizedDocument, NormalizedLine } from "./normalizer.ts";

/**
 * The six v0 validation rules. Each is deterministic, never mutates the
 * document, and returns at least one result so the report shows it ran.
 * Convention: `expected` is what code computed or requires; `actual` is what
 * the document says.
 */
export const RULE_SET_VERSION = "v0.1";

export interface Rule {
  id: string;
  version: string;
  description: string;
  run(doc: NormalizedDocument): CheckResult[];
}

/** ISO 4217 codes accepted in v0. Anything else routes to review; nothing is converted. */
export const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set([
  "USD", "EUR", "GBP", "CNY", "JPY", "CAD", "MXN", "KRW", "TWD", "HKD",
  "INR", "VND", "THB", "IDR", "MYR", "PHP", "AUD", "CHF", "SGD", "TRY",
]);

function dec(a: Amount): Decimal {
  return new Decimal(a.value);
}

type ResultInit = Omit<CheckResult, "ruleId" | "ruleVersion" | "severity"> & { severity?: Severity };

function maker(rule: { id: string; version: string }, defaultSeverity: Severity) {
  return (init: ResultInit): CheckResult => ({
    ruleId: rule.id,
    ruleVersion: rule.version,
    severity: init.severity ?? defaultSeverity,
    outcome: init.outcome,
    row: init.row,
    page: init.page,
    field: init.field,
    expected: init.expected,
    actual: init.actual,
    message: init.message,
  });
}

const REQUIRED_HEADER = ["invoiceNumber", "invoiceTotal"] as const;
const REQUIRED_LINE = ["sku", "description", "quantity", "unitPrice", "extendedPrice"] as const;

export const requiredFields: Rule = {
  id: "required-fields",
  version: "1",
  description: "Header and line fields needed to build an entry are present and readable.",
  run(doc) {
    const r = maker(this, "blocking");
    const out: CheckResult[] = [];
    const missingHeader = REQUIRED_HEADER.filter((f) => doc.header[f] === null);
    out.push(
      r({
        outcome: missingHeader.length ? "fail" : "pass",
        row: null,
        page: null,
        field: missingHeader.join(",") || null,
        expected: REQUIRED_HEADER.join(","),
        actual: missingHeader.length ? `missing: ${missingHeader.join(",")}` : "all present",
        message: missingHeader.length
          ? `Invoice header is missing or has unreadable ${missingHeader.join(", ")}. Enter from the source document.`
          : "Required header fields present.",
      }),
    );
    for (const line of doc.lines) {
      const missing = REQUIRED_LINE.filter((f) => line[f] === null);
      out.push(
        r({
          outcome: missing.length ? "fail" : "pass",
          row: line.row,
          page: line.page,
          field: missing.join(",") || null,
          expected: REQUIRED_LINE.join(","),
          actual: missing.length ? `missing: ${missing.join(",")}` : "all present",
          message: missing.length
            ? `Line is missing or has unreadable ${missing.join(", ")}.`
            : "Required line fields present.",
        }),
      );
      if (line.countryOfOrigin === null) {
        out.push(
          r({
            severity: "warning",
            outcome: "fail",
            row: line.row,
            page: line.page,
            field: "countryOfOrigin",
            expected: "country of origin",
            actual: null,
            message: "No country of origin printed on this line; supply it from the catalog or the importer.",
          }),
        );
      }
    }
    return out;
  },
};

export const lineMath: Rule = {
  id: "line-math",
  version: "1",
  description: "quantity × unit price equals extended price, rounded half-up to the printed precision.",
  run(doc) {
    const r = maker(this, "blocking");
    return doc.lines.map((line) => {
      const base = { row: line.row, page: line.page, field: "extendedPrice" };
      if (!line.quantity || !line.unitPrice || !line.extendedPrice) {
        return r({ ...base, outcome: "skipped", expected: null, actual: null, message: "Skipped: quantity, unit price or extended price missing." });
      }
      const scale = line.extendedPrice.scale;
      const expected = dec(line.quantity).times(dec(line.unitPrice)).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
      const actual = dec(line.extendedPrice);
      const ok = expected.eq(actual);
      return r({
        ...base,
        outcome: ok ? "pass" : "fail",
        expected: expected.toFixed(scale),
        actual: actual.toFixed(scale),
        message: ok
          ? "Line math matches."
          : `${line.quantity.raw} × ${line.unitPrice.raw} = ${expected.toFixed(scale)}, but the line shows ${line.extendedPrice.raw} (difference ${actual.minus(expected).toFixed(scale)}). Check quantity, price and extended price on the source.`,
      });
    });
  },
};

export const invoiceTotal: Rule = {
  id: "invoice-total",
  version: "1",
  description: "Sum of extended prices equals the printed invoice total.",
  run(doc) {
    const r = maker(this, "blocking");
    const base = { row: null, page: null, field: "invoiceTotal" };
    const total = doc.header.invoiceTotal;
    if (!total) {
      return [r({ ...base, outcome: "fail", expected: null, actual: null, message: "No readable invoice total, so line completeness can't be reconciled." })];
    }
    const missing = doc.lines.filter((l) => !l.extendedPrice).map((l) => l.row);
    if (missing.length) {
      return [r({ ...base, outcome: "skipped", expected: null, actual: total.value, message: `Skipped: rows ${missing.join(", ")} have no extended price.` })];
    }
    const sum = doc.lines.reduce((acc, l) => acc.plus(dec(l.extendedPrice as Amount)), new Decimal(0));
    const ok = sum.eq(dec(total));
    const scale = Math.max(total.scale, ...doc.lines.map((l) => (l.extendedPrice as Amount).scale));
    return [
      r({
        ...base,
        outcome: ok ? "pass" : "fail",
        expected: sum.toFixed(scale),
        actual: dec(total).toFixed(scale),
        message: ok
          ? "Lines sum to the invoice total."
          : `Lines sum to ${sum.toFixed(scale)} but the invoice total is ${total.raw} (difference ${dec(total).minus(sum).toFixed(scale)}). Look for missing, duplicated or misread lines, or unsupported charges such as freight or discounts.`,
      }),
    ];
  },
};

function lineKey(l: NormalizedLine): string | null {
  if (!l.sku) return null;
  return JSON.stringify([l.sku, l.description, l.quantity?.value, l.unitPrice?.value, l.extendedPrice?.value]);
}

export const duplicateLines: Rule = {
  id: "duplicate-lines",
  version: "1",
  description: "No two lines share SKU, description, quantity and prices.",
  run(doc) {
    const r = maker(this, "blocking");
    const seen = new Map<string, NormalizedLine>();
    const out: CheckResult[] = [];
    for (const line of doc.lines) {
      const key = lineKey(line);
      if (key === null) continue;
      const first = seen.get(key);
      if (first) {
        out.push(
          r({
            outcome: "fail",
            row: line.row,
            page: line.page,
            field: null,
            expected: "unique line",
            actual: `duplicate of row ${first.row} (page ${first.page})`,
            message: `Row ${line.row} repeats row ${first.row} exactly. Confirm on the source whether it is a real second line or a duplicated read.`,
          }),
        );
      } else {
        seen.set(key, line);
      }
    }
    if (!out.length) {
      out.push(r({ outcome: "pass", row: null, page: null, field: null, expected: "unique lines", actual: "no duplicates", message: "No duplicate lines." }));
    }
    return out;
  },
};

export const pageContinuity: Rule = {
  id: "page-continuity",
  version: "1",
  description: "Every page was extracted, lines reference real pages, and no split row is left unmerged.",
  run(doc) {
    const r = maker(this, "blocking");
    const out: CheckResult[] = [];
    const byPage = new Map(doc.pages.map((p) => [p.page, p]));
    for (let p = 1; p <= doc.pageCount; p++) {
      const status = byPage.get(p);
      if (!status || status.status !== "extracted") {
        out.push(
          r({
            outcome: "fail",
            row: null,
            page: p,
            field: null,
            expected: "page extracted",
            actual: status ? `failed: ${status.error ?? "unknown error"}` : "no extraction for page",
            message: `Page ${p} of ${doc.pageCount} has no valid extraction, so its lines may be missing. Re-run extraction or enter the page manually.`,
          }),
        );
      }
    }
    for (const status of doc.pages) {
      if (status.page > doc.pageCount) {
        out.push(r({ outcome: "fail", row: null, page: status.page, field: null, expected: `page <= ${doc.pageCount}`, actual: String(status.page), message: "Extraction references a page the document does not have." }));
      }
    }
    for (const line of doc.lines) {
      if (line.page > doc.pageCount) {
        out.push(r({ outcome: "fail", row: line.row, page: line.page, field: "page", expected: `page <= ${doc.pageCount}`, actual: String(line.page), message: "Line references a page the document does not have." }));
      }
      if (line.continuesOnNextPage || line.continuedFromPreviousPage) {
        out.push(
          r({
            outcome: "fail",
            row: line.row,
            page: line.page,
            field: null,
            expected: "complete row",
            actual: line.continuesOnNextPage ? "continues on next page, unmerged" : "continued from previous page, unmerged",
            message: "Row is split across a page break and could not be merged with its other half. Reconstruct it from the source.",
          }),
        );
      }
    }
    if (!out.length) {
      out.push(r({ outcome: "pass", row: null, page: null, field: null, expected: `${doc.pageCount} pages`, actual: `${doc.pageCount} pages`, message: "All pages extracted; no unmerged split rows." }));
    }
    return out;
  },
};

export const currency: Rule = {
  id: "currency",
  version: "1",
  description: "Invoice currency is present and a supported ISO 4217 code.",
  run(doc) {
    const r = maker(this, "blocking");
    const c = doc.header.currency;
    const ok = c !== null && SUPPORTED_CURRENCIES.has(c);
    return [
      r({
        outcome: ok ? "pass" : "fail",
        row: null,
        page: null,
        field: "currency",
        expected: "supported ISO 4217 code",
        actual: c,
        message: ok
          ? `Currency ${c}.`
          : c === null
            ? "No invoice currency found. Symbols like $ are ambiguous; confirm the currency from the source."
            : `Currency "${c}" is not a supported ISO 4217 code. Confirm the currency from the source.`,
      }),
    ];
  },
};

export const V0_RULES: readonly Rule[] = [requiredFields, lineMath, invoiceTotal, duplicateLines, pageContinuity, currency];

export function runRules(doc: NormalizedDocument, rules: readonly Rule[] = V0_RULES): CheckResult[] {
  return rules.flatMap((rule) => rule.run(doc));
}
