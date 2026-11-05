import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import writeXlsxFile from "write-excel-file/node";
import { CatalogFormatError, loadCatalog, matchCatalog, normalizeDocument } from "../src/index.ts";
import { cleanDoc, line } from "./helpers.ts";

async function sheet(name: string, contents: string | Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cea-catalog-"));
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

const CSV = "\uFEFFItem Number,Description,HTS Code,COO\n ab-100 ,Steel bracket,7326.90.8688,cn\nAB-200,Hinge,8302104000,\nCD-300,Gasket,4016935010,VN\n";

describe("loadCatalog", () => {
  it("reads CSV with header aliases, BOM, dotted HTS and normalized SKUs", async () => {
    const c = await loadCatalog(await sheet("skus.csv", CSV));
    expect([...c.entries.keys()]).toEqual(["AB-100", "AB-200", "CD-300"]);
    expect(c.entries.get("AB-100")?.[0]).toEqual({ sku: "AB-100", rawSku: "ab-100", description: "Steel bracket", hts10: "7326908688", countryOfOrigin: "CN", sheetRow: 2 });
    expect(c.entries.get("AB-200")?.[0]?.countryOfOrigin).toBeNull();
    expect(c.findings).toEqual([]);
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a sheet without SKU or HTS columns", async () => {
    await expect(loadCatalog(await sheet("s.csv", "name,price\nx,1\n"))).rejects.toThrow(CatalogFormatError);
  });

  it("refuses unsupported file types", async () => {
    await expect(loadCatalog(await sheet("s.xls", "x"))).rejects.toThrow(/unsupported/);
  });

  it("skips rows with invalid HTS, reporting the sheet row", async () => {
    const c = await loadCatalog(await sheet("s.csv", "sku,hts10\nAB-1,7326\n,7326908688\n"));
    expect(c.entries.size).toBe(0);
    expect(c.findings.map((f) => f.message)).toEqual([
      expect.stringContaining("Sheet row 2 skipped"),
      expect.stringContaining("Sheet row 3 skipped"),
    ]);
  });

  it("reads XLSX and restores a leading zero lost to a numeric HTS cell, with a warning", async () => {
    const buf = await writeXlsxFile([
      [{ value: "SKU" }, { value: "HTS" }],
      [{ value: "AB-100" }, { value: 101210010, type: Number }],
      [{ value: "AB-200" }, { value: "0101210020" }],
    ]).toBuffer();
    const c = await loadCatalog(await sheet("s.xlsx", buf));
    expect(c.entries.get("AB-100")?.[0]?.hts10).toBe("0101210010");
    expect(c.entries.get("AB-200")?.[0]?.hts10).toBe("0101210020");
    expect(c.findings).toHaveLength(1);
    expect(c.findings[0]).toMatchObject({ severity: "warning", field: "hts10" });
  });
});

describe("matchCatalog", () => {
  it("matches exactly on normalized SKU and marks the value state", async () => {
    const c = await loadCatalog(await sheet("s.csv", CSV));
    const { lines, checks } = matchCatalog(normalizeDocument(cleanDoc()), c);
    expect(lines.map((l) => l.match)).toEqual([
      { status: "matched", hts10: "7326908688", htsSource: "catalog-matched", sheetRow: 2 },
      { status: "matched", hts10: "8302104000", htsSource: "catalog-matched", sheetRow: 3 },
      { status: "matched", hts10: "4016935010", htsSource: "catalog-matched", sheetRow: 4 },
    ]);
    expect(checks.every((c) => c.outcome === "pass")).toBe(true);
  });

  it("blocks (R4) on unmatched SKUs; no fuzzy matching", async () => {
    const c = await loadCatalog(await sheet("s.csv", CSV));
    const doc = cleanDoc();
    doc.lines = [line({ sku: "AB-1OO" })];
    const { lines, checks } = matchCatalog(normalizeDocument(doc), c);
    expect(lines[0]!.match.status).toBe("unmatched");
    expect(lines[0]!.match.hts10).toBeNull();
    expect(checks[0]).toMatchObject({ ruleId: "R4-sku-match", severity: "blocking", outcome: "fail", row: 1, page: 1, actual: "AB-1OO" });
  });

  it("flags SKUs with conflicting HTS rows as ambiguous", async () => {
    const c = await loadCatalog(await sheet("s.csv", "sku,hts\nAB-100,7326908688\nab-100,7326908600\n"));
    const { lines, checks } = matchCatalog(normalizeDocument(cleanDoc()), c);
    expect(lines[0]!.match.status).toBe("ambiguous");
    expect(checks[0]).toMatchObject({ outcome: "fail", severity: "blocking", actual: "7326908688 / 7326908600 (sheet rows 2, 3)" });
  });

  it("skips lines with no SKU", async () => {
    const c = await loadCatalog(await sheet("s.csv", CSV));
    const doc = cleanDoc();
    doc.lines = [line({ sku: null })];
    const { lines, checks } = matchCatalog(normalizeDocument(doc), c);
    expect(lines[0]!.match.status).toBe("no-sku");
    expect(checks[0]!.outcome).toBe("skipped");
  });
});
