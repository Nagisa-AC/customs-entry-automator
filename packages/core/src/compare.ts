import Decimal from "decimal.js";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MatchedLine } from "./catalog.ts";
import { isBlockingFailure } from "./checks.ts";
import type { Report } from "./export.ts";
import type { ExtractionProvider } from "./extract/types.ts";
import type { NormalizedDocument, NormalizedHeader } from "./normalizer.ts";
import { runPipeline } from "./pipeline.ts";

/** Ground truth written alongside each labeled invoice (see packages/fixtures). */
export interface GroundTruth {
  invoice: string;
  /** Weights are canonical decimal plus unit as printed, e.g. "2512.5 LBS". */
  header: { invoiceNumber: string; currency: string; invoiceTotal: string; totalGrossWeight: string; totalNetWeight: string };
  lines: {
    row: number;
    sku: string;
    description: string;
    quantity: string;
    unitPrice: string;
    extendedPrice: string;
    countryOfOrigin: string | null;
    hts10: string | null;
  }[];
}

export const SCORED_FIELDS = ["sku", "description", "quantity", "unitPrice", "extendedPrice", "countryOfOrigin", "hts10"] as const;
export type ScoredField = (typeof SCORED_FIELDS)[number];
/** Fields whose silent corruption would change an entry. */
const CRITICAL: readonly ScoredField[] = ["quantity", "unitPrice", "extendedPrice", "countryOfOrigin", "hts10"];
const HEADER_FIELDS = ["invoiceNumber", "currency", "invoiceTotal", "totalGrossWeight", "totalNetWeight"] as const;
type HeaderField = (typeof HEADER_FIELDS)[number];

export interface InvoiceScore {
  invoice: string;
  status: Report["status"];
  pages: number;
  expectedLines: number;
  extractedLines: number;
  alignedLines: number;
  fieldCorrect: Record<ScoredField, number>;
  headerCorrect: Record<HeaderField, boolean>;
  /** Wrong critical values not covered by any blocking finding (would reach review unflagged). */
  silentErrors: { row: number | null; field: string }[];
  failedPages: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toUpperCase();
const sameNumber = (a: string | null | undefined, b: string | null | undefined) => a != null && b != null && new Decimal(a).eq(b);

function fieldCorrect(line: MatchedLine, gt: GroundTruth["lines"][number], field: ScoredField): boolean {
  switch (field) {
    case "quantity":
    case "unitPrice":
    case "extendedPrice":
      return sameNumber(line[field]?.value, gt[field]);
    case "hts10":
      return norm(line.match.hts10) === norm(gt.hts10);
    default:
      return norm(line[field]) === norm(gt[field]);
  }
}

function headerCorrect(header: NormalizedHeader, gt: GroundTruth["header"], field: HeaderField): boolean {
  switch (field) {
    case "invoiceTotal":
      return sameNumber(header.invoiceTotal?.value, gt.invoiceTotal);
    case "totalGrossWeight":
    case "totalNetWeight": {
      const [value, unit = ""] = gt[field].split(" ");
      return sameNumber(header[field]?.value, value) && (header[field]?.unit ?? "") === norm(unit).replace(/S$/, "");
    }
    default:
      return norm(header[field]) === norm(gt[field]);
  }
}

/**
 * Align extracted lines to ground truth by SKU, in order (first unused match),
 * then score fields on aligned pairs. Unaligned extracted lines count against
 * precision; unaligned ground-truth lines against recall.
 */
export function scoreInvoice(gt: GroundTruth, report: Report, header: NormalizedHeader, lines: readonly MatchedLine[]): InvoiceScore {
  const used = new Set<number>();
  const pairs: [MatchedLine, GroundTruth["lines"][number]][] = [];
  for (const g of gt.lines) {
    const idx = lines.findIndex((l, i) => !used.has(i) && norm(l.sku) === norm(g.sku));
    if (idx < 0) continue;
    used.add(idx);
    pairs.push([lines[idx] as MatchedLine, g]);
  }
  const blocking = report.checks.filter(isBlockingFailure);
  const blockingRows = new Set(blocking.map((c) => c.row));
  const correct = Object.fromEntries(SCORED_FIELDS.map((f) => [f, 0])) as Record<ScoredField, number>;
  const silentErrors: InvoiceScore["silentErrors"] = [];
  for (const [line, g] of pairs) {
    for (const f of SCORED_FIELDS) {
      if (fieldCorrect(line, g, f)) correct[f]++;
      else if (CRITICAL.includes(f) && !blockingRows.has(line.row)) silentErrors.push({ row: line.row, field: f });
    }
  }
  const headerScore = Object.fromEntries(HEADER_FIELDS.map((f) => [f, headerCorrect(header, gt.header, f)])) as Record<HeaderField, boolean>;
  const docBlocked = blocking.length > 0;
  for (const f of ["currency", "invoiceTotal", "totalGrossWeight", "totalNetWeight"] as const) {
    if (!headerScore[f] && !docBlocked) silentErrors.push({ row: null, field: f });
  }
  const pages = report.extraction.pages;
  return {
    invoice: gt.invoice,
    status: report.status,
    pages: pages.length,
    expectedLines: gt.lines.length,
    extractedLines: lines.length,
    alignedLines: pairs.length,
    fieldCorrect: correct,
    headerCorrect: headerScore,
    silentErrors,
    failedPages: pages.filter((p) => p.status === "failed").length,
    latencyMs: pages.reduce((a, p) => a + (p.latencyMs ?? 0), 0),
    inputTokens: pages.reduce((a, p) => a + (p.inputTokens ?? 0), 0),
    outputTokens: pages.reduce((a, p) => a + (p.outputTokens ?? 0), 0),
  };
}

export interface ProviderSpec {
  /** Label used for output folders and the table. */
  name: string;
  /** Builds the provider for one invoice folder (fixture-style providers need the folder). */
  create(invoiceDir: string): ExtractionProvider;
}

/** USD per million tokens, keyed by provider id or "<id>/<model>". */
export type PriceTable = Record<string, { inputPerMTok: number; outputPerMTok: number }>;

export interface ProviderSummary {
  name: string;
  provider: string;
  model: string;
  invoices: number;
  pages: number;
  statuses: Record<string, number>;
  lineRecall: number;
  linePrecision: number;
  fieldAccuracy: Record<ScoredField, number>;
  headerAccuracy: Record<HeaderField, number>;
  silentErrors: number;
  failedPages: number;
  latencyMsPerPage: number;
  inputTokens: number;
  outputTokens: number;
  /** null when no price is configured for this provider/model. */
  costUsd: number | null;
  perInvoice: InvoiceScore[];
}

export interface ComparisonOptions {
  setDir: string;
  outDir: string;
  providers: readonly ProviderSpec[];
  prices?: PriceTable;
  useCache?: boolean;
}

const ratio = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 10000) / 10000);

export function listLabeledInvoices(setDir: string): string[] {
  return readdirSync(setDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && ["invoice.pdf", "ground-truth.json"].every((f) => existsSync(join(setDir, d.name, f))))
    .map((d) => d.name)
    .sort();
}

function skuSheet(dir: string): string {
  const found = ["sku-sheet.csv", "sku-sheet.xlsx"].map((f) => join(dir, f)).find((p) => existsSync(p));
  if (!found) throw new Error(`${dir} has no sku-sheet.csv or sku-sheet.xlsx`);
  return found;
}

function summarize(spec: ProviderSpec, provider: ExtractionProvider, scores: InvoiceScore[], prices: PriceTable | undefined): ProviderSummary {
  const sum = (f: (s: InvoiceScore) => number) => scores.reduce((a, s) => a + f(s), 0);
  const aligned = sum((s) => s.alignedLines);
  const pages = sum((s) => s.pages);
  const inputTokens = sum((s) => s.inputTokens);
  const outputTokens = sum((s) => s.outputTokens);
  const price = prices?.[`${provider.id}/${provider.model}`] ?? prices?.[provider.id];
  const statuses: Record<string, number> = {};
  for (const s of scores) statuses[s.status] = (statuses[s.status] ?? 0) + 1;
  return {
    name: spec.name,
    provider: provider.id,
    model: provider.model,
    invoices: scores.length,
    pages,
    statuses,
    lineRecall: ratio(aligned, sum((s) => s.expectedLines)),
    linePrecision: ratio(aligned, sum((s) => s.extractedLines)),
    fieldAccuracy: Object.fromEntries(SCORED_FIELDS.map((f) => [f, ratio(sum((s) => s.fieldCorrect[f]), aligned)])) as Record<ScoredField, number>,
    headerAccuracy: Object.fromEntries(HEADER_FIELDS.map((f) => [f, ratio(scores.filter((s) => s.headerCorrect[f]).length, scores.length)])) as Record<HeaderField, number>,
    silentErrors: sum((s) => s.silentErrors.length),
    failedPages: sum((s) => s.failedPages),
    latencyMsPerPage: pages ? Math.round(sum((s) => s.latencyMs) / pages) : 0,
    inputTokens,
    outputTokens,
    costUsd: price ? Math.round(((inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1e6) * 1e6) / 1e6 : null,
    perInvoice: scores,
  };
}

export function comparisonMarkdown(summaries: readonly ProviderSummary[]): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const rows: [string, (s: ProviderSummary) => string][] = [
    ["Model", (s) => `${s.provider}/${s.model}`],
    ["Invoices / pages", (s) => `${s.invoices} / ${s.pages}`],
    ["Silent errors", (s) => String(s.silentErrors)],
    ["Line recall", (s) => pct(s.lineRecall)],
    ["Line precision", (s) => pct(s.linePrecision)],
    ...SCORED_FIELDS.map((f): [string, (s: ProviderSummary) => string] => [`Accuracy: ${f}`, (s) => pct(s.fieldAccuracy[f])]),
    ...HEADER_FIELDS.map((f): [string, (s: ProviderSummary) => string] => [`Header: ${f}`, (s) => pct(s.headerAccuracy[f])]),
    ["Failed pages", (s) => String(s.failedPages)],
    ["Statuses", (s) => Object.entries(s.statuses).map(([k, v]) => `${k} ${v}`).join(", ")],
    ["Latency / page", (s) => `${s.latencyMsPerPage} ms`],
    ["Tokens in / out", (s) => `${s.inputTokens} / ${s.outputTokens}`],
    ["Cost", (s) => (s.costUsd === null ? "no price set" : `$${s.costUsd.toFixed(4)}`)],
  ];
  const header = `| Metric | ${summaries.map((s) => s.name).join(" | ")} |`;
  const sep = `|---|${summaries.map(() => "---").join("|")}|`;
  return [header, sep, ...rows.map(([label, f]) => `| ${label} | ${summaries.map(f).join(" | ")} |`)].join("\n") + "\n";
}

/**
 * Run every provider over the labeled set through the full pipeline and score
 * against ground truth. Raw extractions are cached per provider, so re-scoring
 * after a rule change costs no model calls.
 */
export async function runComparison(opts: ComparisonOptions): Promise<ProviderSummary[]> {
  const invoices = listLabeledInvoices(opts.setDir);
  if (!invoices.length) throw new Error(`no labeled invoices (invoice.pdf + ground-truth.json) under ${opts.setDir}`);
  const summaries: ProviderSummary[] = [];
  for (const spec of opts.providers) {
    const scores: InvoiceScore[] = [];
    let provider: ExtractionProvider | null = null;
    for (const name of invoices) {
      const dir = join(opts.setDir, name);
      provider = spec.create(dir);
      const out = join(opts.outDir, spec.name, name);
      const { report } = await runPipeline({
        pdfPath: join(dir, "invoice.pdf"),
        skuSheetPath: skuSheet(dir),
        outDir: out,
        provider,
        ...(opts.useCache === undefined ? {} : { useCache: opts.useCache }),
      });
      const gt = JSON.parse(await readFile(join(dir, "ground-truth.json"), "utf8")) as GroundTruth;
      const normalized = JSON.parse(await readFile(join(out, "normalized.json"), "utf8")) as NormalizedDocument;
      const matched = JSON.parse(await readFile(join(out, "matched.json"), "utf8")) as { lines: MatchedLine[] };
      scores.push(scoreInvoice(gt, report, normalized.header, matched.lines));
    }
    summaries.push(summarize(spec, provider as ExtractionProvider, scores, opts.prices));
  }
  await mkdir(opts.outDir, { recursive: true });
  await writeFile(join(opts.outDir, "comparison.json"), JSON.stringify(summaries, null, 2) + "\n");
  await writeFile(join(opts.outDir, "comparison.md"), comparisonMarkdown(summaries));
  return summaries;
}
