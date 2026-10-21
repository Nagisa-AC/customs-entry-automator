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
with affected rows marked `needs_review`, and the CLI exits 1. Saved raw extractions are reused by cache key,
so re-runs never call the model; `--from <stage>` re-runs from any stage
using the saved outputs of earlier ones.

To use a real model: `--provider openai` with `OPENAI_API_KEY`,
`CEA_OPENAI_MODEL` (required) and optionally `OPENAI_BASE_URL`. Without keys,
only invoices that have recorded extractions can run.

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
