import {
  EXTRACTION_SCHEMA_VERSION,
  FixtureProvider,
  isBlockingFailure,
  OpenAIProvider,
  openAIConfigFromEnv,
  PIPELINE_VERSIONS,
  runPipeline,
  STAGES,
  type ExtractionProvider,
  type PipelineResult,
  type Stage,
} from "@cea/core";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { parseArgs } from "node:util";

const USAGE = `usage:
  cea run <invoice.pdf> --skus <sheet.csv|xlsx> [--out <dir>] [--provider auto|fixture|openai]
          [--fixture-dir <dir>] [--from <stage>] [--no-cache]
  cea run-set <dir> [--out <dir>] [--provider auto|fixture|openai]
  cea version

stages: ${STAGES.join(", ")}
--provider auto (default) uses recorded extractions when <pdf dir>/extractions exists
(or --fixture-dir is given), otherwise OpenAI (OPENAI_API_KEY + CEA_OPENAI_MODEL).
run-set expects one folder per invoice containing invoice.pdf and sku-sheet.csv|xlsx.
Without blocking findings the lines go to lines.csv. With any blocking finding only
lines.review.csv is written (affected rows marked needs_review) and the exit code is 1.
Real providers also need CEA_PROVIDER_ZERO_RETENTION=confirmed and CEA_PROVIDER_REGION=us,
set only after verifying the account's contract terms.
exit codes: 0 ready_for_approval, 1 needs_review or failed (run-set: any invoice), 2 usage or fatal error.`;

class UsageError extends Error {}

export function selectProvider(
  name: string,
  pdfPath: string,
  fixtureDir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ExtractionProvider {
  const recorded = fixtureDir ?? join(dirname(pdfPath), "extractions");
  if (name === "fixture" || (name === "auto" && (fixtureDir !== undefined || existsSync(recorded)))) {
    if (!existsSync(recorded)) throw new UsageError(`no recorded extractions at ${recorded}`);
    return new FixtureProvider(recorded);
  }
  if (name === "openai" || name === "auto") {
    if (name === "auto" && !env.OPENAI_API_KEY) {
      throw new UsageError("no recorded extractions found and OPENAI_API_KEY is not set; pass --fixture-dir or configure a provider");
    }
    return new OpenAIProvider(openAIConfigFromEnv(env));
  }
  throw new UsageError(`unknown provider "${name}"`);
}

function printResult(pdfPath: string, outDir: string, result: PipelineResult, provider: ExtractionProvider) {
  const { report } = result;
  const s = report.summary;
  console.log(`${pdfPath} -> ${relative(process.cwd(), outDir) || "."}`);
  console.log(
    `  provider ${provider.id}/${provider.model}; ${report.input.pageCount} page(s): ${result.calledPages} extracted, ${result.cachedPages} from cache`,
  );
  console.log(
    `  status ${report.status}: ${s.lines} lines, ${s.catalogMatched}/${s.lines} catalog-matched, ${s.checks} checks (${s.passed} pass, ${s.failed} fail, ${s.skipped} skipped), ${s.blocking} blocking, ${s.warnings} warning(s)`,
  );
  const fails = report.checks.filter((c) => c.outcome === "fail");
  for (const c of fails.slice(0, 20)) {
    const where = [c.row !== null ? `row ${c.row}` : null, c.page !== null ? `page ${c.page}` : null].filter(Boolean).join(" ");
    console.log(`  ${isBlockingFailure(c) ? "BLOCKING" : "warning "} ${c.ruleId}${where ? ` (${where})` : ""}: ${c.message}`);
  }
  if (fails.length > 20) console.log(`  ... ${fails.length - 20} more in report.json`);
  console.log(`  wrote report.json and ${result.linesFile}${result.linesFile === "lines.review.csv" ? " (blocking findings; no lines.csv)" : ""}`);
}

async function runOne(
  pdfPath: string,
  skus: string,
  outDir: string,
  providerName: string,
  fixtureDir: string | undefined,
  from: Stage | undefined,
  useCache: boolean,
): Promise<PipelineResult> {
  const provider = selectProvider(providerName, pdfPath, fixtureDir);
  const result = await runPipeline({ pdfPath, skuSheetPath: skus, outDir, provider, useCache, ...(from ? { from } : {}) });
  printResult(pdfPath, outDir, result, provider);
  return result;
}

function findSkuSheet(dir: string): string | undefined {
  return ["sku-sheet.csv", "sku-sheet.xlsx"].map((f) => join(dir, f)).find((p) => existsSync(p));
}

export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "version" || command === "--version") {
      console.log(`cea (schema ${EXTRACTION_SCHEMA_VERSION})`);
      console.log(JSON.stringify(PIPELINE_VERSIONS));
      return 0;
    }
    if (command === "run" || command === "run-set") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          skus: { type: "string" },
          out: { type: "string" },
          provider: { type: "string", default: "auto" },
          "fixture-dir": { type: "string" },
          from: { type: "string" },
          "no-cache": { type: "boolean", default: false },
        },
      });
      const from = values.from as Stage | undefined;
      if (from !== undefined && !STAGES.includes(from)) throw new UsageError(`unknown stage "${from}"`);
      const [target] = positionals;
      if (!target || positionals.length > 1) throw new UsageError(`${command} takes exactly one path`);

      if (command === "run") {
        if (!values.skus) throw new UsageError("--skus is required");
        const outDir = values.out ?? join(".cea-out", basename(target, extname(target)));
        const result = await runOne(target, values.skus, outDir, values.provider, values["fixture-dir"], from, !values["no-cache"]);
        return result.report.status === "ready_for_approval" ? 0 : 1;
      }

      const outRoot = values.out ?? ".cea-out";
      const dirs = readdirSync(target, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(target, d.name, "invoice.pdf")))
        .map((d) => d.name)
        .sort();
      if (!dirs.length) throw new UsageError(`no <name>/invoice.pdf folders under ${target}`);
      const statuses: [string, string][] = [];
      for (const name of dirs) {
        const dir = join(target, name);
        const skus = findSkuSheet(dir);
        if (!skus) throw new UsageError(`${dir} has no sku-sheet.csv or sku-sheet.xlsx`);
        const result = await runOne(join(dir, "invoice.pdf"), skus, join(outRoot, name), values.provider, undefined, from, !values["no-cache"]);
        statuses.push([name, result.report.status]);
      }
      console.log(`\n${statuses.length} invoice(s):`);
      for (const [name, status] of statuses) console.log(`  ${status.padEnd(18)} ${name}`);
      return statuses.every(([, status]) => status === "ready_for_approval") ? 0 : 1;
    }
    console.log(USAGE);
    return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  } catch (err) {
    if (err instanceof UsageError || (err instanceof TypeError && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS"))) {
      console.error(`error: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    console.error(`error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run(process.argv.slice(2));
}
