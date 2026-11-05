import {
  AnthropicProvider,
  anthropicConfigFromEnv,
  comparisonMarkdown,
  EXTRACTION_SCHEMA_VERSION,
  FixtureProvider,
  isBlockingFailure,
  OpenAIProvider,
  openAIConfigFromEnv,
  PIPELINE_VERSIONS,
  runComparison,
  runPipeline,
  SimulatedNoisyProvider,
  STAGES,
  type ExtractionProvider,
  type PriceTable,
  type PipelineResult,
  type Stage,
} from "@cea/core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { parseArgs } from "node:util";

const PROVIDERS = "auto|fixture|openai|anthropic|simulated-noisy";

const USAGE = `usage:
  cea run <invoice.pdf> --skus <sheet.csv|xlsx> [--out <dir>] [--provider ${PROVIDERS}]
          [--fixture-dir <dir>] [--from <stage>] [--no-cache]
  cea run-set <dir> [--out <dir>] [--provider ${PROVIDERS}]
  cea compare <labeled-set-dir> --providers <a,b,...> [--out <dir>] [--prices <prices.json>] [--no-cache]
  cea version

stages: ${STAGES.join(", ")}
--provider auto (default) uses only recorded extractions (<pdf dir>/extractions or
--fixture-dir) and fails when there are none; it never calls a model. Real providers run
only when named: openai needs OPENAI_API_KEY + CEA_OPENAI_MODEL, anthropic needs
ANTHROPIC_API_KEY + CEA_ANTHROPIC_MODEL. simulated-noisy is an offline,
deliberately error-prone stand-in for exercising compare without keys.
run-set expects one folder per invoice containing invoice.pdf and sku-sheet.csv|xlsx;
compare additionally needs ground-truth.json. --prices is JSON:
{"<provider>" or "<provider>/<model>": {"inputPerMTok": n, "outputPerMTok": n}}.
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
  if (name === "auto" || name === "fixture") {
    if (!existsSync(recorded)) {
      throw new UsageError(
        `no recorded extractions at ${recorded}; --provider ${name} never calls a model. Pass --fixture-dir, or name a real provider with --provider openai|anthropic`,
      );
    }
    return new FixtureProvider(recorded);
  }
  if (name === "simulated-noisy") {
    if (!existsSync(recorded)) throw new UsageError(`no recorded extractions at ${recorded}`);
    return new SimulatedNoisyProvider(recorded);
  }
  if (name === "anthropic") return new AnthropicProvider(anthropicConfigFromEnv(env));
  if (name === "openai") return new OpenAIProvider(openAIConfigFromEnv(env));
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
    if (command === "compare") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          providers: { type: "string" },
          out: { type: "string", default: join(".cea-out", "compare") },
          prices: { type: "string" },
          "no-cache": { type: "boolean", default: false },
        },
      });
      const [setDir] = positionals;
      if (!setDir || positionals.length > 1) throw new UsageError("compare takes exactly one labeled-set folder");
      const names = (values.providers ?? "").split(",").map((p) => p.trim()).filter(Boolean);
      if (!names.length) throw new UsageError("--providers is required, e.g. --providers openai,anthropic");
      const prices = values.prices ? (JSON.parse(readFileSync(values.prices, "utf8")) as PriceTable) : undefined;
      const summaries = await runComparison({
        setDir,
        outDir: values.out,
        providers: names.map((name) => ({ name, create: (dir: string) => selectProvider(name, join(dir, "invoice.pdf"), undefined) })),
        useCache: !values["no-cache"],
        ...(prices ? { prices } : {}),
      });
      console.log(comparisonMarkdown(summaries));
      console.log(`wrote ${join(values.out, "comparison.json")} and comparison.md`);
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
