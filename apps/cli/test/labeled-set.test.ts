import { fixtureDir, INVOICES_DIR, listFixtures } from "@cea/fixtures";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { run, selectProvider } from "../src/main.ts";

interface Report {
  status: string;
  summary: { lines: number; blocking: number };
  extraction: { pages: { status: string }[] };
  checks: { ruleId: string; row: number | null; page: number | null; outcome: string; severity: string }[];
}

interface GroundTruth {
  lines: { row: number; hts10: string | null }[];
  expectedFailures: { ruleId: string; row: number | null }[];
}

async function tree(dir: string, prefix = ""): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = join(prefix, e.name);
    if (e.isDirectory()) for (const [k, v] of await tree(join(dir, e.name), rel)) out.set(k, v);
    else out.set(rel, await readFile(join(dir, e.name)));
  }
  return out;
}

const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
};

describe("M1 exit criterion on the synthetic labeled set", () => {
  let out: string;
  let first: Map<string, Buffer>;

  beforeAll(async () => {
    quiet();
    out = await mkdtemp(join(tmpdir(), "cea-set-"));
    expect(await run(["run-set", INVOICES_DIR, "--out", out])).toBe(1);
    first = await tree(out);
  }, 60_000);

  it("runs every invoice end to end and writes every stage output", () => {
    for (const name of listFixtures()) {
      for (const f of ["pages/manifest.json", "extract/manifest.json", "stitched.json", "normalized.json", "checks.json", "matched.json", "report.json"]) {
        expect(first.has(join(name, f)), `${name}/${f}`).toBe(true);
      }
    }
  });

  it("writes lines.csv only without blocking findings, otherwise only lines.review.csv", () => {
    for (const name of listFixtures()) {
      const report = JSON.parse(first.get(join(name, "report.json"))!.toString()) as Report;
      const blocked = report.summary.blocking > 0;
      expect(first.has(join(name, "lines.csv")), `${name} lines.csv`).toBe(!blocked);
      expect(first.has(join(name, "lines.review.csv")), `${name} lines.review.csv`).toBe(blocked);
    }
    const review = first.get(join("broken-math-unmatched", "lines.review.csv"))!.toString().split("\r\n");
    expect(review.filter((r) => r.includes(",needs_review,")).length).toBeGreaterThan(0);
    expect(review.filter((r) => r.includes(",ok,")).length).toBeGreaterThan(0);
  });

  it("repeat runs on cached extractions give byte-identical output", async () => {
    quiet();
    expect(await run(["run-set", INVOICES_DIR, "--out", out])).toBe(1);
    const second = await tree(out);
    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [k, v] of first) expect(second.get(k)?.equals(v), k).toBe(true);
  }, 60_000);

  it("replaying from any stage without the model gives identical reports", async () => {
    quiet();
    const name = "multipage-split-rows";
    const dir = fixtureDir(name);
    for (const from of ["extract", "stitch", "normalize", "validate", "match", "export"]) {
      await run(["run", join(dir, "invoice.pdf"), "--skus", join(dir, "sku-sheet.csv"), "--out", join(out, name), "--from", from]);
      expect((await readFile(join(out, name, "report.json"))).equals(first.get(join(name, "report.json"))!), from).toBe(true);
    }
  }, 60_000);

  it.each(listFixtures())("%s: every expected failure, and nothing else, is in the report", async (name) => {
    const report = JSON.parse(first.get(join(name, "report.json"))!.toString()) as Report;
    const gt = JSON.parse(await readFile(join(fixtureDir(name), "ground-truth.json"), "utf8")) as GroundTruth;
    const expected = [
      ...gt.expectedFailures,
      ...gt.lines.filter((l) => l.hts10 === null).map((l) => ({ ruleId: "R4-sku-match", row: l.row })),
    ];
    const failures = report.checks.filter((c) => c.outcome === "fail").map((c) => ({ ruleId: c.ruleId, row: c.row }));
    expect(failures).toEqual(expected);
    expect(report.status).toBe(expected.length && report.checks.some((c) => c.outcome === "fail" && c.severity === "blocking") ? "needs_review" : "ready_for_approval");
    expect(report.checks.every((c) => typeof c.ruleId === "string" && "row" in c && "page" in c)).toBe(true);
    expect((report as unknown as { adjustments: unknown }).adjustments).toEqual({ probableLines: [], r2Failed: false });
  });

  it("removes a stale lines.csv when a re-run becomes blocked", async () => {
    quiet();
    const work = await mkdtemp(join(tmpdir(), "cea-stale-"));
    await cp(fixtureDir("clean-us-single-page"), join(work, "inv"), { recursive: true });
    const args = ["run", join(work, "inv", "invoice.pdf"), "--skus", join(work, "inv", "sku-sheet.csv"), "--out", join(work, "out")];
    expect(await run(args)).toBe(0);
    expect(existsSync(join(work, "out", "lines.csv"))).toBe(true);
    await writeFile(join(work, "inv", "sku-sheet.csv"), "sku,hts10\n");
    await writeFile(join(work, "inv", "extractions", "page-001.json"), "not json");
    expect(await run([...args, "--no-cache"])).toBe(1);
    expect(existsSync(join(work, "out", "lines.csv"))).toBe(false);
    expect(existsSync(join(work, "out", "lines.review.csv"))).toBe(true);
  });

  it("an unmatched SKU alone blocks: no lines.csv, the row is needs_review, exit 1", async () => {
    quiet();
    const work = await mkdtemp(join(tmpdir(), "cea-r4-"));
    await cp(fixtureDir("clean-us-single-page"), join(work, "inv"), { recursive: true });
    const sheet = (await readFile(join(work, "inv", "sku-sheet.csv"), "utf8")).split("\n");
    await writeFile(join(work, "inv", "sku-sheet.csv"), sheet.filter((_, i) => i !== 1).join("\n"));
    const code = await run(["run", join(work, "inv", "invoice.pdf"), "--skus", join(work, "inv", "sku-sheet.csv"), "--out", join(work, "out")]);
    expect(code).toBe(1);
    const report = JSON.parse(await readFile(join(work, "out", "report.json"), "utf8")) as Report;
    expect(report.status).toBe("needs_review");
    expect(existsSync(join(work, "out", "lines.csv"))).toBe(false);
    const csv = (await readFile(join(work, "out", "lines.review.csv"), "utf8")).split("\r\n");
    expect(csv[1]).toMatch(/,,,needs_review,R4-sku-match$/);
    expect(csv.slice(2).filter(Boolean).every((r) => r.includes(",ok,"))).toBe(true);
  });

  it("a page that fails extraction shows up in the report and blocks", async () => {
    quiet();
    const work = await mkdtemp(join(tmpdir(), "cea-fail-"));
    const src = fixtureDir("multipage-split-rows");
    await cp(src, join(work, "inv"), { recursive: true });
    await rm(join(work, "inv", "extractions", "page-002.json"));
    const code = await run(["run", join(work, "inv", "invoice.pdf"), "--skus", join(work, "inv", "sku-sheet.csv"), "--out", join(work, "out")]);
    expect(code).toBe(1);
    const report = JSON.parse(await readFile(join(work, "out", "report.json"), "utf8")) as Report;
    expect(report.status).toBe("needs_review");
    expect(report.extraction.pages.map((p) => p.status)).toEqual(["extracted", "failed", "extracted"]);
    const continuity = report.checks.filter((c) => c.ruleId === "R7-page-continuity" && c.outcome === "fail");
    expect(continuity.some((c) => c.page === 2 && c.row === null)).toBe(true);
    expect(report.checks.find((c) => c.ruleId === "R2-footer-total")?.outcome).not.toBe("pass");
  });
});

describe("cli", () => {
  it("returns 2 on usage errors", async () => {
    quiet();
    expect(await run(["run"])).toBe(2);
    expect(await run(["run", "x.pdf"])).toBe(2);
    expect(await run(["run", "x.pdf", "--skus", "s.csv", "--from", "bogus"])).toBe(2);
    expect(await run(["bogus"])).toBe(2);
  });

  it("selects the fixture provider when recordings exist, and requires keys otherwise", () => {
    const pdf = join(fixtureDir("clean-us-single-page"), "invoice.pdf");
    expect(selectProvider("auto", pdf, undefined, {}).id).toBe("fixture");
    expect(() => selectProvider("auto", "/nowhere/invoice.pdf", undefined, {})).toThrow(/OPENAI_API_KEY/);
    expect(() => selectProvider("openai", pdf, undefined, {})).toThrow(/zero data retention/);
    expect(() => selectProvider("openai", pdf, undefined, { OPENAI_API_KEY: "k", CEA_OPENAI_MODEL: "m" })).toThrow(/zero data retention/);
    expect(
      selectProvider("openai", pdf, undefined, { OPENAI_API_KEY: "k", CEA_OPENAI_MODEL: "m", CEA_PROVIDER_ZERO_RETENTION: "confirmed", CEA_PROVIDER_REGION: "us" }).id,
    ).toBe("openai");
  });
});
