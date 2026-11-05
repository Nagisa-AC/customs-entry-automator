import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export interface PdfLimits {
  timeoutMs: number;
  /** V8 heap cap for the worker process. */
  maxMemoryMb: number;
  maxPages: number;
  maxBytes: number;
  renderScale: number;
  /** Caps native canvas memory, which the V8 heap limit does not cover. */
  maxPixelsPerPage: number;
}

export const DEFAULT_PDF_LIMITS: PdfLimits = {
  timeoutMs: 60_000,
  maxMemoryMb: 512,
  maxPages: 50,
  maxBytes: 25 * 1024 * 1024,
  renderScale: 2,
  maxPixelsPerPage: 4000 * 4000,
};

export interface LoadedPage {
  page: number;
  width: number;
  height: number;
  imagePath: string;
  imageSha256: string;
  textPath: string;
  textSha256: string;
  hasTextLayer: boolean;
}

export interface LoadedPdf {
  sha256: string;
  pageCount: number;
  pages: LoadedPage[];
}

export type PdfErrorCode =
  | "timeout"
  | "out-of-memory"
  | "too-large"
  | "too-many-pages"
  | "page-too-large"
  | "invalid-pdf"
  | "worker-crashed";

export class PdfLoadError extends Error {
  readonly code: PdfErrorCode;
  constructor(code: PdfErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "PdfLoadError";
    this.code = code;
  }
}

const WORKER = fileURLToPath(new URL("./pdf-worker.mjs", import.meta.url));

/**
 * Render every page to PNG and read any text layer, inside a child Node
 * process with a heap cap, a wall-clock timeout and an empty environment
 * (no API keys or other secrets reach the parser).
 */
export async function loadPdf(pdfPath: string, outDir: string, overrides: Partial<PdfLimits> = {}): Promise<LoadedPdf> {
  const limits: PdfLimits = { ...DEFAULT_PDF_LIMITS, ...overrides };
  await mkdir(outDir, { recursive: true });

  return new Promise<LoadedPdf>((resolve, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${limits.maxMemoryMb}`, WORKER], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new PdfLoadError("timeout", `PDF processing exceeded ${limits.timeoutMs} ms`)));
    }, limits.timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => finish(() => reject(new PdfLoadError("worker-crashed", err.message))));
    child.on("close", (code, signal) => {
      finish(() => {
        const line = stdout.trim().split("\n").pop();
        if (line) {
          try {
            const result = JSON.parse(line) as ({ ok: true } & LoadedPdf) | { ok: false; code: PdfErrorCode; message: string };
            if (result.ok) {
              resolve({ sha256: result.sha256, pageCount: result.pageCount, pages: result.pages });
            } else {
              reject(new PdfLoadError(result.code, result.message));
            }
            return;
          } catch {
            // fall through to crash classification
          }
        }
        if (/heap out of memory|Allocation failed/i.test(stderr)) {
          reject(new PdfLoadError("out-of-memory", `worker exceeded ${limits.maxMemoryMb} MB heap`));
        } else {
          reject(new PdfLoadError("worker-crashed", `worker exited (code ${code}, signal ${signal})`));
        }
      });
    });

    child.stdin.end(JSON.stringify({ pdfPath: resolvePath(pdfPath), outDir: resolvePath(outDir), limits }));
  });
}
