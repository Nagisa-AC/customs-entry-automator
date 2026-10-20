import { parse as parseCsv } from "csv-parse/sync";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { readSheet } from "read-excel-file/node";
import type { CheckResult } from "./checks.ts";
import { normalizeSku, type NormalizedDocument, type NormalizedLine } from "./normalizer.ts";

export const CATALOG_MATCHER_VERSION = "catalog-exact-v1";

export interface CatalogEntry {
  sku: string;
  rawSku: string;
  description: string | null;
  hts10: string;
  countryOfOrigin: string | null;
  /** 1-based row in the sheet, header = row 1. */
  sheetRow: number;
}

export interface Catalog {
  file: string;
  sha256: string;
  /** Normalized SKU -> every valid entry for it. More than one distinct HTS is ambiguous. */
  entries: Map<string, CatalogEntry[]>;
  findings: CheckResult[];
}

export class CatalogFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogFormatError";
  }
}

const COLUMN_ALIASES = {
  sku: ["sku", "item", "item number", "item no", "part number", "part no", "product code", "style"],
  hts10: ["hts10", "hts", "hts code", "hts number", "htsus", "tariff", "hs code"],
  description: ["description", "desc", "product description"],
  countryOfOrigin: ["country_of_origin", "country of origin", "origin", "coo"],
} as const;

type Column = keyof typeof COLUMN_ALIASES;

function sheetWarning(field: string, expected: string, actual: string | null, message: string): CheckResult {
  return { ruleId: "catalog-sheet", ruleVersion: "1", severity: "warning", outcome: "fail", row: null, page: null, field, expected, actual, message };
}

/** Numeric XLSX cells are tagged so a number-typed HTS (which loses leading zeros) is detectable. */
interface NumericCell {
  numeric: string;
}

interface SheetCell {
  text: string;
  numeric: boolean;
}

function toCell(v: unknown): SheetCell {
  if (v !== null && typeof v === "object" && "numeric" in v) return { text: String((v as NumericCell).numeric).trim(), numeric: true };
  if (v === null || v === undefined) return { text: "", numeric: false };
  return { text: String(v).trim(), numeric: false };
}

function headerIndex(header: string[]): Record<Column, number> {
  const norm = header.map((h) => h.trim().toLowerCase().replace(/[_-]+/g, " "));
  const find = (col: Column) => norm.findIndex((h) => (COLUMN_ALIASES[col] as readonly string[]).some((a) => a.replace(/_/g, " ") === h));
  const idx = { sku: find("sku"), hts10: find("hts10"), description: find("description"), countryOfOrigin: find("countryOfOrigin") };
  const missing = (["sku", "hts10"] as const).filter((c) => idx[c] < 0);
  if (missing.length) {
    throw new CatalogFormatError(`SKU sheet is missing required column(s): ${missing.join(", ")} (found: ${header.join(", ")})`);
  }
  return idx;
}

/** Reads a CSV or XLSX SKU sheet. Only exact, explicit columns are used; nothing is inferred. */
export async function loadCatalog(path: string): Promise<Catalog> {
  const bytes = await readFile(path);
  const ext = extname(path).toLowerCase();
  let rows: SheetCell[][];
  if (ext === ".csv") {
    const parsed = parseCsv(bytes, { bom: true, skip_empty_lines: true, relax_column_count: true }) as string[][];
    rows = parsed.map((r) => r.map(toCell));
  } else if (ext === ".xlsx") {
    const data = await readSheet<NumericCell>(bytes, { parseNumber: (s: string) => ({ numeric: s }) });
    rows = data.map((r) => r.map(toCell));
  } else {
    throw new CatalogFormatError(`unsupported SKU sheet type "${ext}"; use .csv or .xlsx`);
  }
  const [header, ...body] = rows;
  if (!header) throw new CatalogFormatError("SKU sheet is empty");
  const idx = headerIndex(header.map((c) => c.text));

  const entries = new Map<string, CatalogEntry[]>();
  const findings: CheckResult[] = [];
  body.forEach((cells, i) => {
    const sheetRow = i + 2;
    const at = (c: Column): SheetCell => (idx[c] >= 0 ? (cells[idx[c]] ?? toCell(null)) : toCell(null));
    if (cells.every((c) => c.text === "")) return;
    const rawSku = at("sku").text;
    const sku = normalizeSku(rawSku);
    const htsCell = at("hts10");
    let hts = htsCell.text.replace(/[.\s-]/g, "");
    if (/^\d{9}$/.test(hts) && htsCell.numeric) {
      hts = `0${hts}`;
      findings.push(sheetWarning("hts10", "10-digit text", htsCell.text, `Sheet row ${sheetRow}: HTS was stored as a number and lost its leading zero; read as ${hts}. Store HTS codes as text.`));
    }
    if (!sku || !/^\d{10}$/.test(hts)) {
      findings.push(
        sku
          ? sheetWarning("hts10", "10-digit HTS code", htsCell.text, `Sheet row ${sheetRow} skipped: HTS is not a 10-digit code. Lines with this SKU will be unmatched.`)
          : sheetWarning("sku", "SKU", null, `Sheet row ${sheetRow} skipped: no SKU.`),
      );
      return;
    }
    const entry: CatalogEntry = {
      sku,
      rawSku,
      description: at("description").text || null,
      hts10: hts,
      countryOfOrigin: at("countryOfOrigin").text.toUpperCase() || null,
      sheetRow,
    };
    entries.set(sku, [...(entries.get(sku) ?? []), entry]);
  });

  return { file: basename(path), sha256: createHash("sha256").update(bytes).digest("hex"), entries, findings };
}

export type MatchStatus = "matched" | "unmatched" | "ambiguous" | "no-sku";

export interface MatchedLine extends NormalizedLine {
  match: {
    status: MatchStatus;
    hts10: string | null;
    /** Value state: only "catalog-matched" in v0; never inferred. */
    htsSource: "catalog-matched" | null;
    sheetRow: number | null;
  };
}

export interface MatchResult {
  lines: MatchedLine[];
  checks: CheckResult[];
}

/** Exact match on normalized SKU. Unmatched and ambiguous lines are blocking. */
export function matchCatalog(doc: NormalizedDocument, catalog: Catalog): MatchResult {
  const checks: CheckResult[] = [];
  const base = { ruleId: "catalog-match", ruleVersion: "1", field: "sku" } as const;
  const lines = doc.lines.map((line): MatchedLine => {
    const where = { row: line.row, page: line.page };
    if (!line.sku) {
      checks.push({ ...base, ...where, severity: "blocking", outcome: "skipped", expected: null, actual: null, message: "Skipped: line has no SKU." });
      return { ...line, match: { status: "no-sku", hts10: null, htsSource: null, sheetRow: null } };
    }
    const found = catalog.entries.get(line.sku) ?? [];
    const distinct = [...new Set(found.map((e) => e.hts10))];
    if (found.length === 0) {
      checks.push({ ...base, ...where, severity: "blocking", outcome: "fail", expected: "SKU in importer catalog", actual: line.sku, message: `SKU ${line.sku} is not in the SKU sheet. Add an approved mapping or classify this line manually.` });
      return { ...line, match: { status: "unmatched", hts10: null, htsSource: null, sheetRow: null } };
    }
    if (distinct.length > 1) {
      checks.push({ ...base, ...where, severity: "blocking", outcome: "fail", expected: "one HTS mapping", actual: `${distinct.join(" / ")} (sheet rows ${found.map((e) => e.sheetRow).join(", ")})`, message: `SKU ${line.sku} maps to more than one HTS code in the SKU sheet. Resolve the mapping before use.` });
      return { ...line, match: { status: "ambiguous", hts10: null, htsSource: null, sheetRow: null } };
    }
    const entry = found[0] as CatalogEntry;
    checks.push({ ...base, ...where, severity: "blocking", outcome: "pass", expected: "SKU in importer catalog", actual: line.sku, message: `Matched sheet row ${entry.sheetRow}.` });
    return { ...line, match: { status: "matched", hts10: entry.hts10, htsSource: "catalog-matched", sheetRow: entry.sheetRow } };
  });
  return { lines, checks };
}
