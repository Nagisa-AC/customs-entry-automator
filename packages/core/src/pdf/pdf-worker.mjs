// Runs in a separate Node process (see load.ts). Reads one job as JSON on stdin,
// writes page images and text to disk, and prints one JSON result line on stdout.
// Plain JS so the sandbox needs no TypeScript loader.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

function fail(code, message) {
  process.stdout.write(JSON.stringify({ ok: false, code, message }) + "\n");
  process.exit(0);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const job = await readStdin();
const { pdfPath, outDir, limits } = job;

const data = await readFile(pdfPath);
if (data.length > limits.maxBytes) fail("too-large", `file is ${data.length} bytes; limit ${limits.maxBytes}`);

const pdfjsDir = dirname(require.resolve("pdfjs-dist/package.json"));
const { getDocument } = await import(pathToFileURL(join(pdfjsDir, "legacy/build/pdf.mjs")).href);
const { createCanvas } = await import("@napi-rs/canvas");

let pdf;
try {
  pdf = await getDocument({
    data: new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: join(pdfjsDir, "standard_fonts") + "/",
    verbosity: 0,
  }).promise;
} catch (err) {
  fail("invalid-pdf", err instanceof Error ? err.name : "unreadable PDF");
}

if (pdf.numPages > limits.maxPages) fail("too-many-pages", `${pdf.numPages} pages; limit ${limits.maxPages}`);

const pages = [];
for (let n = 1; n <= pdf.numPages; n++) {
  const page = await pdf.getPage(n);
  const content = await page.getTextContent();
  const lines = [];
  let current = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    current.push(item.str);
    if (item.hasEOL) {
      lines.push(current.join(""));
      current = [];
    }
  }
  if (current.length) lines.push(current.join(""));
  const text = lines.join("\n");

  const viewport = page.getViewport({ scale: limits.renderScale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  if (width * height > limits.maxPixelsPerPage) {
    fail("page-too-large", `page ${n} renders to ${width}x${height}; limit ${limits.maxPixelsPerPage} pixels`);
  }
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const png = canvas.toBuffer("image/png");

  const stem = `page-${String(n).padStart(3, "0")}`;
  const imagePath = join(outDir, `${stem}.png`);
  const textPath = join(outDir, `${stem}.txt`);
  await writeFile(imagePath, png);
  await writeFile(textPath, text, "utf8");
  pages.push({
    page: n,
    width,
    height,
    imagePath,
    imageSha256: sha256(png),
    textPath,
    textSha256: sha256(Buffer.from(text, "utf8")),
    hasTextLayer: text.trim().length > 0,
  });
  page.cleanup();
}

process.stdout.write(JSON.stringify({ ok: true, sha256: sha256(data), pageCount: pdf.numPages, pages }) + "\n");
process.exit(0);
