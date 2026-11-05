import { fixtureDir, listFixtures } from "@cea/fixtures";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPdf, PdfLoadError } from "../src/pdf/load.ts";

const tmp = () => mkdtemp(join(tmpdir(), "cea-pdf-"));
const pdfOf = (name: string) => join(fixtureDir(name), "invoice.pdf");

async function expectPdfError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PdfLoadError);
  expect((err as PdfLoadError).code).toBe(code);
}

describe("loadPdf (sandboxed subprocess)", () => {
  it.each(listFixtures())("renders and reads the text layer of %s", async (name) => {
    const gt = JSON.parse(await readFile(join(fixtureDir(name), "ground-truth.json"), "utf8"));
    const out = await tmp();
    const loaded = await loadPdf(pdfOf(name), out, { renderScale: 1 });
    expect(loaded.pageCount).toBe(gt.pageCount);
    expect(loaded.pages).toHaveLength(gt.pageCount);
    const page1 = loaded.pages[0]!;
    expect(page1.hasTextLayer).toBe(true);
    expect(await readFile(page1.textPath, "utf8")).toContain(gt.header.invoiceNumber);
    const png = await readFile(page1.imagePath);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(page1.width).toBe(612);
  });

  it("is deterministic across runs", async () => {
    const a = await loadPdf(pdfOf("multipage-split-rows"), await tmp(), { renderScale: 1 });
    const b = await loadPdf(pdfOf("multipage-split-rows"), await tmp(), { renderScale: 1 });
    expect(a.sha256).toBe(b.sha256);
    expect(a.pages.map((p) => [p.imageSha256, p.textSha256])).toEqual(b.pages.map((p) => [p.imageSha256, p.textSha256]));
  });

  it("rejects files that are not PDFs", async () => {
    const dir = await tmp();
    const bogus = join(dir, "bogus.pdf");
    await writeFile(bogus, "this is not a pdf");
    await expectPdfError(loadPdf(bogus, dir), "invalid-pdf");
  });

  it("enforces the page limit", async () => {
    await expectPdfError(loadPdf(pdfOf("multipage-split-rows"), await tmp(), { maxPages: 2 }), "too-many-pages");
  });

  it("enforces the byte limit", async () => {
    await expectPdfError(loadPdf(pdfOf("clean-us-single-page"), await tmp(), { maxBytes: 100 }), "too-large");
  });

  it("enforces the per-page pixel limit", async () => {
    await expectPdfError(loadPdf(pdfOf("clean-us-single-page"), await tmp(), { maxPixelsPerPage: 1000 }), "page-too-large");
  });

  it("kills the worker on timeout", async () => {
    await expectPdfError(loadPdf(pdfOf("clean-us-single-page"), await tmp(), { timeoutMs: 1 }), "timeout");
  });
});
