import Decimal from "decimal.js";

/**
 * "dot":   1,234.56  (dot is the decimal mark)
 * "comma": 1.234,56  (comma is the decimal mark)
 * Spaces, no-break spaces and apostrophes are accepted as grouping in either.
 */
export type DecimalFormat = "dot" | "comma";

export interface FormatDetection {
  format: DecimalFormat | null;
  dotVotes: number;
  commaVotes: number;
  ambiguous: number;
  reason: string;
}

export interface ParsedNumber {
  value: Decimal;
  /** Number of decimal places as printed ("12.50" -> 2). */
  scale: number;
}

export type ParseOutcome = { ok: true; parsed: ParsedNumber } | { ok: false; reason: string };

const SPACE_GROUPING = /[\s\u00a0\u202f']/g;
const CURRENCY_PREFIX = /^(?:[A-Z]{3}|US\$|[$€£¥])\s*/i;
const CURRENCY_SUFFIX = /\s*(?:[A-Z]{3}|[$€£¥])$/i;

interface Stripped {
  core: string;
  negative: boolean;
}

function strip(raw: string, allowCurrency: boolean): Stripped | null {
  let s = raw.trim();
  let negative = false;
  const parens = /^\((.*)\)$/.exec(s);
  if (parens?.[1] !== undefined) {
    negative = true;
    s = parens[1].trim();
  }
  if (allowCurrency) {
    s = s.replace(CURRENCY_PREFIX, "").replace(CURRENCY_SUFFIX, "");
  }
  if (s.startsWith("-")) {
    if (negative) return null;
    negative = true;
    s = s.slice(1);
  } else if (s.endsWith("-")) {
    if (negative) return null;
    negative = true;
    s = s.slice(0, -1);
  }
  if (allowCurrency) {
    s = s.replace(CURRENCY_PREFIX, "").replace(CURRENCY_SUFFIX, "");
  }
  s = s.trim();
  if (!/^\d[\d.,\s\u00a0\u202f']*$/.test(s) || /[\s\u00a0\u202f']$/.test(s)) return null;
  return { core: s, negative };
}

type Vote = "dot" | "comma" | "ambiguous" | "none";

function vote(core: string): Vote {
  const s = core.replace(SPACE_GROUPING, "");
  const dots = s.split(".").length - 1;
  const commas = s.split(",").length - 1;
  if (dots > 0 && commas > 0) return s.lastIndexOf(".") > s.lastIndexOf(",") ? "dot" : "comma";
  if (dots === 0 && commas === 0) return "none";
  const sep = dots > 0 ? "." : ",";
  if (dots + commas > 1) return sep === "." ? "comma" : "dot";
  const idx = s.indexOf(sep);
  const digitsAfter = s.length - idx - 1;
  const intPart = s.slice(0, idx);
  // "1,234" could be either; "0,500" can only be a decimal because "0" never leads a group.
  if (digitsAfter === 3 && intPart !== "0") return "ambiguous";
  return sep === "." ? "dot" : "comma";
}

/**
 * Decide the document's decimal mark once, from every numeric string on it.
 * Conflicting evidence or only-ambiguous evidence yields `format: null`.
 */
export function detectDecimalFormat(raws: readonly string[]): FormatDetection {
  let dotVotes = 0;
  let commaVotes = 0;
  let ambiguous = 0;
  for (const raw of raws) {
    const stripped = strip(raw, true);
    if (!stripped) continue;
    const v = vote(stripped.core);
    if (v === "dot") dotVotes++;
    else if (v === "comma") commaVotes++;
    else if (v === "ambiguous") ambiguous++;
  }
  const counts = { dotVotes, commaVotes, ambiguous };
  if (dotVotes > 0 && commaVotes > 0) {
    return { format: null, ...counts, reason: "document mixes dot-decimal and comma-decimal numbers" };
  }
  if (dotVotes > 0) return { format: "dot", ...counts, reason: "dot used as decimal mark" };
  if (commaVotes > 0) return { format: "comma", ...counts, reason: "comma used as decimal mark" };
  if (ambiguous > 0) {
    return { format: null, ...counts, reason: "every separated number is ambiguous (e.g. 1,234)" };
  }
  return { format: "dot", ...counts, reason: "no decimal separators present; integers only" };
}

function escape(ch: string): string {
  return ch === "." ? "\\." : ch;
}

function parseCore(core: string, format: DecimalFormat): ParsedNumber | null {
  const dec = format === "dot" ? "." : ",";
  const grp = format === "dot" ? "," : ".";
  const s = core.replace(SPACE_GROUPING, grp);
  const d = escape(dec);
  const g = escape(grp);
  const grouped = new RegExp(`^\\d{1,3}(?:${g}\\d{3})+(?:${d}(\\d+))?$`);
  const plain = new RegExp(`^\\d+(?:${d}(\\d+))?$`);
  const m = grouped.exec(s) ?? plain.exec(s);
  if (!m) return null;
  const normalized = s.split(grp).join("").replace(dec, ".");
  return { value: new Decimal(normalized), scale: m[1]?.length ?? 0 };
}

/**
 * Parse one printed number under a known format. With `format: null` the value
 * is accepted only when both readings agree ("12" yes, "1,234" no).
 */
export function parseNumber(raw: string, format: DecimalFormat | null, allowCurrency: boolean): ParseOutcome {
  const stripped = strip(raw, allowCurrency);
  if (!stripped) return { ok: false, reason: "not a number" };
  let parsed: ParsedNumber | null;
  if (format) {
    parsed = parseCore(stripped.core, format);
    if (!parsed) return { ok: false, reason: `invalid grouping or decimals for ${format}-decimal format` };
  } else {
    const a = parseCore(stripped.core, "dot");
    const b = parseCore(stripped.core, "comma");
    if (!a || !b || !a.value.eq(b.value)) return { ok: false, reason: "decimal format unknown and value is ambiguous" };
    parsed = a;
  }
  return { ok: true, parsed: { value: stripped.negative ? parsed.value.neg() : parsed.value, scale: parsed.scale } };
}
