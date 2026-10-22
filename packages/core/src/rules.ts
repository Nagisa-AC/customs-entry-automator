import Decimal from "decimal.js";
import type { CheckResult, Severity } from "./checks.ts";
import type { Amount, NormalizedDocument, NormalizedLine, Weight, WeightUnit } from "./normalizer.ts";

/**
 * The v0 validation rules (R1–R3 and R5–R7; R4, SKU match, runs in the
 * catalog stage). Each is deterministic, never mutates the document, and
 * returns at least one result so the report shows it ran. Severity "blocking"
 * is the design's Fail; "warning" is its Warn.
 * Convention: `expected` is what code computed or requires; `actual` is what
 * the document says.
 */
export const RULE_SET_VERSION = "v0.3";

export const RULE_IDS = {
  lineMath: "R1-line-math",
  footerTotal: "R2-footer-total",
  weights: "R3-weights",
  skuMatch: "R4-sku-match",
  requiredFields: "R5-required-fields",
  duplicateLines: "R6-duplicate-lines",
  pageContinuity: "R7-page-continuity",
} as const;

export interface Rule {
  id: string;
  version: string;
  description: string;
  run(doc: NormalizedDocument): CheckResult[];
}

/** One cent in the invoice currency. */
export const CENT = new Decimal("0.01");

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

export const lineMath: Rule = {
  id: RULE_IDS.lineMath,
  version: "2",
  description: "quantity × unit price equals extended price within 0.01.",
  run(doc) {
    const r = maker(this, "blocking");
    return doc.lines.map((line) => {
      const base = { row: line.row, page: line.page, field: "extendedPrice" };
      if (!line.quantity || !line.unitPrice) {
        return r({ ...base, outcome: "skipped", expected: null, actual: null, message: "Skipped: quantity or unit price missing (see R5)." });
      }
      const expected = dec(line.quantity).times(dec(line.unitPrice));
      if (!line.extendedPrice) {
        return r({ ...base, outcome: "fail", expected: expected.toFixed(), actual: null, message: "No readable extended price, so the line can't be verified. Enter it from the source." });
      }
      const actual = dec(line.extendedPrice);
      const diff = actual.minus(expected);
      const ok = diff.abs().lte(CENT);
      return r({
        ...base,
        outcome: ok ? "pass" : "fail",
        expected: expected.toFixed(),
        actual: actual.toFixed(line.extendedPrice.scale),
        message: ok
          ? "Line math matches within 0.01."
          : `${line.quantity.raw} × ${line.unitPrice.raw} = ${expected.toFixed()}, but the line shows ${line.extendedPrice.raw} (difference ${diff.toFixed()}). Check quantity, price and extended price on the source.`,
      });
    });
  },
};

export interface ChargeReconciliation {
  /** Sum of line extended prices plus signed charges, at the printed precision; null when a charge amount is unreadable. */
  linesPlusCharges: string | null;
  /** Whether that sum equals the invoice total within R2's tolerance; null when it can't be computed. */
  matchesTotal: boolean | null;
  tolerance: string;
  unreadableCharges: number[];
  inferredSigns: number[];
}

/**
 * Lines plus signed charges vs. the invoice total, with R2's tolerance.
 * Evidence for R2's finding and the report's adjustments counter; it never
 * changes R2's outcome. Null when R2 itself can't compare (no total or a
 * line without an extended price).
 */
export function reconcileCharges(doc: NormalizedDocument): ChargeReconciliation | null {
  const total = doc.header.invoiceTotal;
  if (!total || doc.lines.some((l) => !l.extendedPrice)) return null;
  const tolerance = CENT.times(doc.lines.length);
  const unreadableCharges = doc.charges.filter((c) => !c.signedAmount).map((c) => c.index);
  const inferredSigns = doc.charges.filter((c) => c.signInferred).map((c) => c.index);
  if (unreadableCharges.length) {
    return { linesPlusCharges: null, matchesTotal: null, tolerance: tolerance.toFixed(2), unreadableCharges, inferredSigns };
  }
  const amounts = [...doc.lines.map((l) => l.extendedPrice as Amount), ...doc.charges.map((c) => c.signedAmount as Amount)];
  const sum = amounts.reduce((acc, a) => acc.plus(dec(a)), new Decimal(0));
  const scale = Math.max(total.scale, ...amounts.map((a) => a.scale));
  return {
    linesPlusCharges: sum.toFixed(scale),
    matchesTotal: dec(total).minus(sum).abs().lte(tolerance),
    tolerance: tolerance.toFixed(2),
    unreadableCharges,
    inferredSigns,
  };
}

function chargeEvidence(doc: NormalizedDocument): string {
  const rec = reconcileCharges(doc);
  if (!rec) return "";
  if (!doc.charges.length) return " No charges were extracted, so lines plus charges equal the lines alone.";
  const list = (ns: number[]) => ns.join(", ");
  if (rec.linesPlusCharges === null) {
    return ` Lines plus charges can't be compared to the total: charge ${list(rec.unreadableCharges)} has no readable amount.`;
  }
  const inferred = rec.inferredSigns.length
    ? ` The sign of charge ${list(rec.inferredSigns)} was inferred: a discount printed without a sign was treated as negative.`
    : "";
  return ` Lines plus ${doc.charges.length} charge(s) sum to ${rec.linesPlusCharges}, which ${rec.matchesTotal ? "matches" : "does not match"} the invoice total within ${rec.tolerance}.${inferred}`;
}

export const footerTotal: Rule = {
  id: RULE_IDS.footerTotal,
  version: "2",
  description: "Sum of extended prices equals the printed total within 0.01 × line count; charges are reported, never added.",
  run(doc) {
    const r = maker(this, "blocking");
    const base = { row: null, page: null, field: "invoiceTotal" };
    const total = doc.header.invoiceTotal;
    if (!total) {
      return [r({ ...base, outcome: "fail", expected: null, actual: null, message: "No readable invoice total, so line completeness can't be reconciled." })];
    }
    const missing = doc.lines.filter((l) => !l.extendedPrice).map((l) => l.row);
    if (missing.length) {
      return [r({ ...base, outcome: "skipped", expected: null, actual: total.value, message: `Skipped: rows ${missing.join(", ")} have no extended price (see R1).` })];
    }
    const sum = doc.lines.reduce((acc, l) => acc.plus(dec(l.extendedPrice as Amount)), new Decimal(0));
    const tolerance = CENT.times(doc.lines.length);
    const diff = dec(total).minus(sum);
    const ok = diff.abs().lte(tolerance);
    const scale = Math.max(total.scale, ...doc.lines.map((l) => (l.extendedPrice as Amount).scale));
    return [
      r({
        ...base,
        outcome: ok ? "pass" : "fail",
        expected: sum.toFixed(scale),
        actual: dec(total).toFixed(scale),
        message: ok
          ? `Lines sum to the invoice total within ${tolerance.toFixed(2)}.`
          : `Lines sum to ${sum.toFixed(scale)} but the invoice total is ${total.raw} (difference ${diff.toFixed(scale)}, tolerance ${tolerance.toFixed(2)}). Assume a row was missed or misread before blaming the invoice.${chargeEvidence(doc)}`,
      }),
    ];
  },
};

/** Exact conversion factors to kilograms. */
const KG_PER_UNIT: Record<WeightUnit, Decimal> = {
  KG: new Decimal(1),
  G: new Decimal("0.001"),
  LB: new Decimal("0.45359237"),
  MT: new Decimal(1000),
};

export const weights: Rule = {
  id: RULE_IDS.weights,
  version: "1",
  description: "Total net weight is not more than total gross weight.",
  run(doc) {
    const r = maker(this, "blocking");
    const base = { row: null, page: null, field: "totalNetWeight" };
    const gross = doc.header.totalGrossWeight;
    const net = doc.header.totalNetWeight;
    if (!gross || !net) {
      const unreadable = (["totalGrossWeight", "totalNetWeight"] as const).filter((f) => doc.header[f] === null && doc.rawHeader[f]?.trim());
      if (unreadable.length) {
        return [r({ ...base, outcome: "skipped", expected: null, actual: null, message: `Skipped: ${unreadable.join(" and ")} could not be read (see parse findings).` })];
      }
      const absent = [!gross && "gross", !net && "net"].filter(Boolean).join(" and ");
      return [
        r({
          ...base,
          severity: "warning",
          outcome: "fail",
          expected: "net and gross weight",
          actual: `no ${absent} weight printed`,
          message: `The invoice prints no total ${absent} weight, so net ≤ gross can't be checked. Take weights from the packing list.`,
        }),
      ];
    }
    if ((gross.unit === null) !== (net.unit === null)) {
      return [
        r({
          ...base,
          outcome: "fail",
          expected: "both weights with a unit, or both without",
          actual: `gross ${gross.raw}, net ${net.raw}`,
          message: "Only one of the weights has a unit, so they can't be compared. Confirm the units on the source.",
        }),
      ];
    }
    const inKg = (w: Weight) => (w.unit === null ? dec(w) : dec(w).times(KG_PER_UNIT[w.unit]));
    const sameUnit = gross.unit === net.unit;
    const g = sameUnit ? dec(gross) : inKg(gross);
    const n = sameUnit ? dec(net) : inKg(net);
    const unitLabel = sameUnit ? (gross.unit ?? "") : "KG";
    const ok = n.lte(g);
    return [
      r({
        ...base,
        outcome: ok ? "pass" : "fail",
        expected: `≤ ${g.toFixed()} ${unitLabel}`.trim(),
        actual: `${n.toFixed()} ${unitLabel}`.trim(),
        message: ok
          ? "Net weight does not exceed gross weight."
          : `Net weight ${net.raw} is more than gross weight ${gross.raw}. One of them is misread or the two are swapped; check the source.`,
      }),
    ];
  },
};

const REQUIRED_LINE = ["sku", "quantity", "unitPrice", "countryOfOrigin"] as const;

export const requiredFields: Rule = {
  id: RULE_IDS.requiredFields,
  version: "2",
  description: "Every line has SKU, quantity, unit price and country of origin.",
  run(doc) {
    const r = maker(this, "blocking");
    return doc.lines.map((line) => {
      const missing = REQUIRED_LINE.filter((f) => line[f] === null);
      return r({
        outcome: missing.length ? "fail" : "pass",
        row: line.row,
        page: line.page,
        field: missing.join(",") || null,
        expected: REQUIRED_LINE.join(","),
        actual: missing.length ? `missing: ${missing.join(",")}` : "all present",
        message: missing.length
          ? `Line is missing or has unreadable ${missing.join(", ")}. Enter from the source document.`
          : "Required line fields present.",
      });
    });
  },
};

function samePriceAndSku(a: NormalizedLine, b: NormalizedLine): boolean {
  return a.sku !== null && a.sku === b.sku && a.unitPrice !== null && b.unitPrice !== null && dec(a.unitPrice).eq(dec(b.unitPrice));
}

export const duplicateLines: Rule = {
  id: RULE_IDS.duplicateLines,
  version: "2",
  description: "The same SKU and unit price do not appear on both sides of a page break.",
  run(doc) {
    const r = maker(this, "warning");
    const out: CheckResult[] = [];
    doc.lines.forEach((line, i) => {
      const prev = doc.lines[i - 1];
      if (!prev || line.page !== prev.page + 1 || !samePriceAndSku(prev, line)) return;
      out.push(
        r({
          outcome: "fail",
          row: line.row,
          page: line.page,
          field: null,
          expected: "distinct rows across the page break",
          actual: `same SKU ${line.sku} and unit price as row ${prev.row} (page ${prev.page})`,
          message: `The first row on page ${line.page} repeats the SKU and price of the last row on page ${prev.page}. It is likely a split or carried-forward row; confirm on the source whether it is a real second line.`,
        }),
      );
    });
    if (!out.length) {
      out.push(r({ outcome: "pass", row: null, page: null, field: null, expected: "distinct rows across page breaks", actual: "no repeats", message: "No SKU and price repeated across a page break." }));
    }
    return out;
  },
};

export const pageContinuity: Rule = {
  id: RULE_IDS.pageContinuity,
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

/** Document rules in R-number order; R4 runs later, against the SKU sheet. */
export const V0_RULES: readonly Rule[] = [lineMath, footerTotal, weights, requiredFields, duplicateLines, pageContinuity];

export function runRules(doc: NormalizedDocument, rules: readonly Rule[] = V0_RULES): CheckResult[] {
  return rules.flatMap((rule) => rule.run(doc));
}
