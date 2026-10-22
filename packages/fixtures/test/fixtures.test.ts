import Decimal from "decimal.js";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INVOICE_SPECS, INVOICES_DIR, fixtureDir, formatNumber, listFixtures, writeFixtures } from "../src/index.ts";

interface GroundTruth {
  pageCount: number;
  header: { invoiceTotal: string };
  lines: { row: number; page: number; extendedPrice: string; sku: string }[];
  charges: { type: string; amount: string; signedAmount: string }[];
}

async function files(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await files(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

describe("formatNumber", () => {
  it("formats both conventions", () => {
    expect(formatNumber(new Decimal("1234567.5"), 2, "dot")).toBe("1,234,567.50");
    expect(formatNumber(new Decimal("1234567.5"), 2, "comma")).toBe("1.234.567,50");
    expect(formatNumber(new Decimal("12"), 0, "comma")).toBe("12");
  });
});

describe("synthetic fixtures", () => {
  it("lists one folder per spec", () => {
    expect(listFixtures()).toEqual(INVOICE_SPECS.map((s) => s.name).sort());
  });

  it("committed files are exactly what the generator produces", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "cea-fixtures-"));
    await writeFixtures(INVOICE_SPECS, tmp);
    const committed = await files(INVOICES_DIR);
    expect(await files(tmp)).toEqual(committed);
    for (const rel of committed) {
      const [a, b] = await Promise.all([readFile(join(tmp, rel)), readFile(join(INVOICES_DIR, rel))]);
      expect(a.equals(b), `${rel} differs; run pnpm --filter @cea/fixtures generate`).toBe(true);
    }
  });

  for (const spec of INVOICE_SPECS) {
    it(`${spec.name}: ground truth is internally consistent`, async () => {
      const gt = JSON.parse(await readFile(join(fixtureDir(spec.name), "ground-truth.json"), "utf8")) as GroundTruth;
      expect(gt.lines).toHaveLength(spec.lines.length);
      expect(gt.charges).toHaveLength(spec.charges?.length ?? 0);
      const sum = [...gt.lines.map((l) => l.extendedPrice), ...gt.charges.map((c) => c.signedAmount)].reduce((a, v) => a.plus(v), new Decimal(0));
      expect(sum.eq(gt.header.invoiceTotal)).toBe(true);
      const pages = await readdir(join(fixtureDir(spec.name), "extractions"));
      expect(pages).toHaveLength(gt.pageCount);
      expect(gt.lines.every((l) => l.page >= 1 && l.page <= gt.pageCount)).toBe(true);
    });
  }

  it("marks split rows on both sides of each page break", async () => {
    const dir = join(fixtureDir("multipage-split-rows"), "extractions");
    const p1 = JSON.parse(await readFile(join(dir, "page-001.json"), "utf8"));
    const p2 = JSON.parse(await readFile(join(dir, "page-002.json"), "utf8"));
    expect(p1.lines.at(-1)).toMatchObject({ continuesOnNextPage: true, quantity: null });
    expect(p2.lines[0]).toMatchObject({ continuedFromPreviousPage: true, sku: null });
    expect(p2.lines.at(-1)).toMatchObject({ continuesOnNextPage: true });
  });

  it("prints weights and incoterms, and plants the R3 and R6 cases in the broken invoice", async () => {
    const dir = join(fixtureDir("broken-math-unmatched"), "extractions");
    const p1 = JSON.parse(await readFile(join(dir, "page-001.json"), "utf8"));
    const p2 = JSON.parse(await readFile(join(dir, "page-002.json"), "utf8"));
    expect(p1.header).toMatchObject({ incoterms: "FOB Xiamen", totalGrossWeight: null });
    expect(p2.header).toMatchObject({ totalGrossWeight: "310 KG", totalNetWeight: "325.4 KG" });
    expect(p2.lines[0]).toMatchObject({ sku: p1.lines.at(-1).sku, unitPrice: p1.lines.at(-1).unitPrice });
    const eu = JSON.parse(await readFile(join(fixtureDir("european-format"), "extractions", "page-002.json"), "utf8"));
    expect(eu.header).toMatchObject({ totalGrossWeight: "1.234,5 kg", totalNetWeight: "1.180 kg" });
  });

  it("records charges only in charges, with the discount printed unsigned", async () => {
    const p1 = JSON.parse(await readFile(join(fixtureDir("freight-discount"), "extractions", "page-001.json"), "utf8"));
    expect(p1.charges).toEqual([
      { page: 1, type: "freight", description: "Ocean freight to Oakland", amount: "185.00" },
      { page: 1, type: "discount", description: "Volume discount", amount: "120.00" },
    ]);
    expect(p1.lines.some((l: { description: string }) => /freight|discount/i.test(l.description))).toBe(false);
    for (const name of ["clean-us-single-page", "multipage-split-rows", "european-format", "broken-math-unmatched"]) {
      const dir = join(fixtureDir(name), "extractions");
      for (const f of await readdir(dir)) expect(JSON.parse(await readFile(join(dir, f), "utf8")).charges, `${name}/${f}`).toEqual([]);
    }
  });
});
