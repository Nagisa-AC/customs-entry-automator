# customs-entry-automator

Turns commercial invoice PDFs into reconciled, catalog-matched line files for
customs brokers. The model only extracts; deterministic TypeScript normalizes,
checks and decides. This repo currently holds the M1 CLI pipeline.

## Layout

- `packages/core` — extraction schema (Zod), normalizer, validation rules, and
  other pure pipeline stages. Numbers are kept as raw printed strings until the
  normalizer parses them with `decimal.js`.
- `packages/core/src/pdf` — PDF render + text-layer reading in a sandboxed
  child process (heap cap, timeout, page/byte/pixel limits, empty env).
- `packages/fixtures` — synthetic invoice PDFs, SKU sheets and ground truth.
- `apps/cli` — the `cea` command that wires the stages together.

## Development

Requires Node 22+ and pnpm 10.

```sh
pnpm install
pnpm check      # typecheck + lint + tests
pnpm test       # Vitest only
pnpm cea version
```

## Running the pipeline

```sh
# One invoice. Uses recorded extractions in <pdf dir>/extractions when present.
pnpm cea run packages/fixtures/invoices/broken-math-unmatched/invoice.pdf \
  --skus packages/fixtures/invoices/broken-math-unmatched/sku-sheet.csv

# Every <name>/invoice.pdf + sku-sheet.csv|xlsx under a folder (the labeled set).
pnpm m1:labeled-set
```

Each stage writes to the output folder (default `.cea-out/<name>/`):
`pages/` (PNG + text layer) → `extract/` (raw and validated output per page)
→ `stitched.json` → `normalized.json` → `checks.json` → `matched.json` →
`report.json` + `lines.csv`. If any blocking finding exists, `lines.csv` is
not written (a stale one is removed); `lines.review.csv` is written instead,
with affected rows marked `needs_review`, and the CLI exits 1. Warnings
(R6 repeated row across a page break, R3 weights not printed) do not block:
the row stays in `lines.csv` with the rule in its `issues` column. An
unmatched SKU (R4) blocks, so a row with no HTS never reaches `lines.csv`.

Checks follow the v0 design's rules: R1 line math (0.01), R2 footer total
(0.01 × line count), R3 net ≤ gross weight, R4 SKU found in the SKU sheet, R5 SKU,
quantity, unit price and origin on every line, R6 same SKU and price across a
page break (warning), R7 page continuity. Freight, discounts, insurance and
other non-product charges are extracted into `charges` (never `lines`, never
dropped) and stay out of both CSVs. R2 still compares only the lines to the
total, so an invoice with charges fails and goes to review; its finding also
says whether lines plus charges match the total. Code applies the sign: a
printed minus or parentheses wins, and only an unsigned discount is treated as
negative (the finding says so). `report.json` has an `adjustments` counter
(not a rule): charges by type, their signed sum, whether a sign was inferred,
whether R2 failed, and whether lines plus charges match. Saved raw extractions are reused by cache key,
so re-runs never call the model; `--from <stage>` re-runs from any stage
using the saved outputs of earlier ones.

`--provider auto` (the default) and `--provider fixture` only replay recorded
extractions and fail when there are none; they never call a model, even with
API keys set. A real model runs only when named: `--provider openai`
(`OPENAI_API_KEY`, `CEA_OPENAI_MODEL`, optional `OPENAI_BASE_URL`) or
`--provider anthropic` (`ANTHROPIC_API_KEY`, `CEA_ANTHROPIC_MODEL`, optional
`ANTHROPIC_BASE_URL`). See `.env.example`. The same applies to
`cea compare --providers`.

## Comparing providers

```sh
pnpm cea compare packages/fixtures/invoices --providers openai,anthropic \
  --prices prices.json --out .cea-out/compare
```

Runs every labeled invoice (`invoice.pdf` + `sku-sheet.*` + `ground-truth.json`)
through the full pipeline per provider and writes `comparison.json` and
`comparison.md`: silent errors (wrong quantity, price, origin or HTS on a row
with no blocking finding, or wrong currency/total on an unblocked invoice),
line recall and precision, per-field and header accuracy, latency per page,
tokens and cost (when `--prices` gives USD per million tokens). Offline,
`--providers fixture,simulated-noisy` exercises the harness with a recorded
"perfect" provider and a deliberately error-prone one.

**Real broker invoices:** do not run any until the provider account is
confirmed for zero data retention and US-region processing. Real providers
refuse to start until the operator sets `CEA_PROVIDER_ZERO_RETENTION=confirmed`
and `CEA_PROVIDER_REGION=us`, which should only be done after verifying the
contract terms.

Exit codes: `0` ready for approval, `1` needs review or failed (for
`run-set`: any invoice), `2` usage or fatal error. `lines.csv` is a generic development artifact, not a
filing-system import format.

Never commit customer documents or API keys. Fixtures in the repo are
synthetic. `samples/real/` and `private-samples/` are git-ignored, but that is only a
second layer: real broker files belong on an encrypted disk outside any folder
an AI coding tool can read.
