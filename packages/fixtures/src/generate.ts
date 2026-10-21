import Decimal from "decimal.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { InvoiceSpec, LineSpec, NumberFormat } from "./specs.ts";

const PAGE_W = 612;
const PAGE_H = 792;
const ROW_H = 16;
const FIXED_DATE = new Date("2026-10-01T00:00:00Z");
const COLS = { sku: 36, description: 104, qty: 322, uom: 372, unitPrice: 410, amount: 480, origin: 552 } as const;

export function formatNumber(value: Decimal, scale: number, format: NumberFormat): string {
  const fixed = value.abs().toFixed(scale);
  const [int, frac] = fixed.split(".") as [string, string | undefined];
  const group = format === "dot" ? "," : ".";
  const mark = format === "dot" ? "." : ",";
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return `${value.isNeg() ? "-" : ""}${grouped}${frac ? mark + frac : ""}`;
}

function scaleOf(canonical: string): number {
  return canonical.includes(".") ? canonical.split(".")[1]!.length : 0;
}

export interface PrintedLine {
  spec: LineSpec;
  qty: string;
  unitPrice: string;
  amount: string;
  amountValue: Decimal;
}

function printLine(spec: LineSpec, format: NumberFormat): PrintedLine {
  const unitScale = Math.max(2, scaleOf(spec.unitPrice));
  const amountValue = spec.amountOverride
    ? new Decimal(spec.amountOverride)
    : new Decimal(spec.qty).times(spec.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return {
    spec,
    qty: formatNumber(new Decimal(spec.qty), 0, format),
    unitPrice: formatNumber(new Decimal(spec.unitPrice), unitScale, format),
    amount: formatNumber(amountValue, 2, format),
    amountValue,
  };
}

function splitDescription(description: string): [string, string] {
  const words = description.split(" ");
  const cut = Math.max(1, Math.floor(words.length / 2));
  return [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
}

interface DrawnRow {
  line: number;
  part: "whole" | "head" | "tail";
}

/** Assign every drawn row to a page, honoring split rows. */
export function layoutRows(spec: InvoiceSpec): DrawnRow[][] {
  const splits = new Set(spec.splitRows ?? []);
  const queue: DrawnRow[] = [];
  spec.lines.forEach((_, i) => {
    if (splits.has(i)) queue.push({ line: i, part: "head" }, { line: i, part: "tail" });
    else queue.push({ line: i, part: "whole" });
  });
  const pages: DrawnRow[][] = [];
  let at = 0;
  for (const count of spec.rowsPerPage) {
    pages.push(queue.slice(at, at + count));
    at += count;
  }
  if (at !== queue.length) throw new Error(`${spec.name}: rowsPerPage covers ${at} rows, need ${queue.length}`);
  pages.forEach((rows, p) => {
    const last = rows[rows.length - 1];
    if (last?.part === "head" && pages[p + 1]?.[0]?.part !== "tail") throw new Error(`${spec.name}: split row not at a page break`);
  });
  return pages;
}

function region(y: number): [number, number, number, number] {
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return [r(30 / PAGE_W), r((PAGE_H - y - 11) / PAGE_H), r(590 / PAGE_W), r((PAGE_H - y + 4) / PAGE_H)];
}

function text(page: PDFPage, font: PDFFont, s: string, x: number, y: number, size = 8) {
  page.drawText(s, { x, y, size, font, color: rgb(0, 0, 0) });
}

export interface GeneratedInvoice {
  pdf: Uint8Array;
  skuSheetCsv: string;
  groundTruth: unknown;
  pageExtractions: unknown[];
}

export async function generateInvoice(spec: InvoiceSpec): Promise<GeneratedInvoice> {
  const printed = spec.lines.map((l) => printLine(l, spec.format));
  const total = printed.reduce((a, p) => a.plus(p.amountValue), new Decimal(0));
  const totalPrinted = formatNumber(total, 2, spec.format);
  const weight = (canonical: string) => `${formatNumber(new Decimal(canonical), scaleOf(canonical), spec.format)} ${spec.weights.unit}`;
  const grossPrinted = weight(spec.weights.gross);
  const netPrinted = weight(spec.weights.net);
  const layout = layoutRows(spec);
  const pageCount = layout.length;

  const doc = await PDFDocument.create();
  doc.setTitle(`Commercial invoice ${spec.invoiceNumber} (synthetic)`);
  doc.setProducer("cea-fixtures");
  doc.setCreator("cea-fixtures");
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pageExtractions: unknown[] = [];

  layout.forEach((rows, p) => {
    const pageNo = p + 1;
    const page = doc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - 50;
    const header: Record<string, string | null> = {
      invoiceNumber: null, invoiceDate: null, currency: null, sellerName: null, buyerName: null,
      incoterms: null, invoiceTotal: null, totalGrossWeight: null, totalNetWeight: null,
    };

    if (pageNo === 1) {
      text(page, bold, "COMMERCIAL INVOICE", 36, y, 16);
      y -= 24;
      text(page, bold, "Seller:", 36, y, 9);
      text(page, font, spec.seller, 80, y, 9);
      y -= 14;
      text(page, bold, "Buyer:", 36, y, 9);
      text(page, font, spec.buyer, 80, y, 9);
      y -= 20;
      text(page, bold, "Invoice No:", 36, y, 9);
      text(page, font, spec.invoiceNumber, 100, y, 9);
      text(page, bold, "Date:", 260, y, 9);
      text(page, font, spec.invoiceDate, 292, y, 9);
      text(page, bold, "Currency:", 420, y, 9);
      text(page, font, spec.currency, 474, y, 9);
      y -= 14;
      text(page, bold, "Incoterms:", 36, y, 9);
      text(page, font, spec.incoterms, 100, y, 9);
      y -= 26;
      Object.assign(header, {
        invoiceNumber: spec.invoiceNumber,
        invoiceDate: spec.invoiceDate,
        currency: spec.currency,
        sellerName: spec.seller,
        buyerName: spec.buyer,
        incoterms: spec.incoterms,
      });
    } else {
      text(page, font, `Invoice ${spec.invoiceNumber} (continued)`, 36, y, 9);
      y -= 30;
    }

    const headings: [keyof typeof COLS, string][] = [
      ["sku", "SKU"], ["description", "Description"], ["qty", "Qty"], ["uom", "UOM"],
      ["unitPrice", "Unit Price"], ["amount", "Amount"], ["origin", "Origin"],
    ];
    for (const [col, label] of headings) text(page, bold, label, COLS[col], y);
    y -= 6;
    page.drawLine({ start: { x: 30, y }, end: { x: 590, y }, thickness: 0.5 });
    y -= ROW_H - 4;

    const lines: unknown[] = [];
    rows.forEach((row, r) => {
      const pl = printed[row.line]!;
      const [head, tail] = splitDescription(pl.spec.description);
      const description = row.part === "whole" ? pl.spec.description : row.part === "head" ? head : tail;
      if (row.part !== "tail") text(page, font, pl.spec.sku, COLS.sku, y);
      text(page, font, description, COLS.description, y);
      const numbers = row.part !== "head";
      if (numbers) {
        text(page, font, pl.qty, COLS.qty, y);
        text(page, font, pl.spec.uom, COLS.uom, y);
        text(page, font, pl.unitPrice, COLS.unitPrice, y);
        text(page, font, pl.amount, COLS.amount, y);
        if (pl.spec.origin) text(page, font, pl.spec.origin, COLS.origin, y);
      }
      lines.push({
        page: pageNo,
        rowOnPage: r + 1,
        sku: row.part === "tail" ? null : pl.spec.sku,
        description,
        quantity: numbers ? pl.qty : null,
        unitOfMeasure: numbers ? pl.spec.uom : null,
        unitPrice: numbers ? pl.unitPrice : null,
        extendedPrice: numbers ? pl.amount : null,
        countryOfOrigin: numbers ? pl.spec.origin : null,
        continuedFromPreviousPage: row.part === "tail",
        continuesOnNextPage: row.part === "head",
        region: region(y),
      });
      y -= ROW_H;
    });

    if (pageNo === pageCount) {
      y -= 4;
      page.drawLine({ start: { x: 30, y: y + 10 }, end: { x: 590, y: y + 10 }, thickness: 0.5 });
      text(page, bold, `TOTAL ${spec.currency}`, COLS.unitPrice - 20, y - 4, 9);
      text(page, bold, totalPrinted, COLS.amount, y - 4, 9);
      header.invoiceTotal = totalPrinted;
      text(page, bold, "Total gross weight:", 36, y - 24, 9);
      text(page, font, grossPrinted, 140, y - 24, 9);
      text(page, bold, "Total net weight:", 36, y - 38, 9);
      text(page, font, netPrinted, 140, y - 38, 9);
      header.totalGrossWeight = grossPrinted;
      header.totalNetWeight = netPrinted;
    }
    text(page, font, `Page ${pageNo} of ${pageCount}`, 270, 30);
    text(page, font, "SYNTHETIC TEST DOCUMENT - NOT A REAL INVOICE", 200, 18, 7);

    pageExtractions.push({ schemaVersion: "extraction-v1", page: pageNo, header, lines });
  });

  const pdf = await doc.save({ useObjectStreams: false });

  const startPage = new Map<number, number>();
  layout.forEach((rows, p) => rows.forEach((row) => startPage.has(row.line) || startPage.set(row.line, p + 1)));

  const groundTruth = {
    invoice: spec.name,
    purpose: spec.purpose,
    synthetic: true,
    decimalFormat: spec.format,
    pageCount,
    header: {
      invoiceNumber: spec.invoiceNumber,
      invoiceDate: spec.invoiceDate,
      currency: spec.currency,
      sellerName: spec.seller,
      buyerName: spec.buyer,
      incoterms: spec.incoterms,
      invoiceTotal: total.toFixed(),
      totalGrossWeight: `${spec.weights.gross} ${spec.weights.unit}`,
      totalNetWeight: `${spec.weights.net} ${spec.weights.unit}`,
    },
    lines: printed.map((pl, i) => ({
      row: i + 1,
      page: startPage.get(i),
      sku: pl.spec.sku,
      description: pl.spec.description,
      quantity: new Decimal(pl.spec.qty).toFixed(),
      unitOfMeasure: pl.spec.uom,
      unitPrice: new Decimal(pl.spec.unitPrice).toFixed(),
      extendedPrice: pl.amountValue.toFixed(),
      countryOfOrigin: pl.spec.origin,
      hts10: pl.spec.inCatalog === false ? null : pl.spec.hts10,
    })),
    expectedFailures: spec.expectedFailures,
  };

  const seen = new Set<string>();
  const csvRows = ["sku,description,hts10,country_of_origin"];
  for (const l of spec.lines) {
    if (l.inCatalog === false || seen.has(l.sku)) continue;
    seen.add(l.sku);
    csvRows.push([l.sku, `"${l.description.replace(/"/g, '""')}"`, l.hts10, l.origin ?? ""].join(","));
  }

  return { pdf, skuSheetCsv: csvRows.join("\n") + "\n", groundTruth, pageExtractions };
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** Write one folder per invoice: invoice.pdf, sku-sheet.csv, ground-truth.json, extractions/page-NNN.json. */
export async function writeFixtures(specs: readonly InvoiceSpec[], outDir: string): Promise<string[]> {
  const written: string[] = [];
  for (const spec of specs) {
    const dir = join(outDir, spec.name);
    await mkdir(join(dir, "extractions"), { recursive: true });
    const gen = await generateInvoice(spec);
    const files: [string, Uint8Array | string][] = [
      ["invoice.pdf", gen.pdf],
      ["sku-sheet.csv", gen.skuSheetCsv],
      ["ground-truth.json", json(gen.groundTruth)],
      ...gen.pageExtractions.map((e, i): [string, string] => [`extractions/page-${String(i + 1).padStart(3, "0")}.json`, json(e)]),
    ];
    for (const [rel, data] of files) {
      await writeFile(join(dir, rel), data);
      written.push(join(spec.name, rel));
    }
  }
  return written;
}
