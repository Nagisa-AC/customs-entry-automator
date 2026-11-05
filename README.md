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

Never commit customer documents or API keys. Fixtures in the repo are
synthetic. `samples/real/` and `private-samples/` are git-ignored, but that is only a
second layer: real broker files belong on an encrypted disk outside any folder
an AI coding tool can read.
