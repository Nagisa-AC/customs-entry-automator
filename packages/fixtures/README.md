# @cea/fixtures

Synthetic invoices for tests and the offline CLI. Every company, SKU, price and
HTS code is invented; no customer data belongs here.

Each folder under `invoices/` holds:

- `invoice.pdf` — the rendered invoice (with a text layer)
- `sku-sheet.csv` — the importer's SKU → HTS sheet
- `ground-truth.json` — expected normalized header and lines, plus the
  failures the pipeline must report (`expectedFailures`)
- `extractions/page-NNN.json` — an ideal per-page extraction in the
  `extraction-v1` schema, replayed by the offline fixture provider

| Fixture | Purpose |
|---|---|
| `clean-us-single-page` | One page, US number format, everything passes |
| `multipage-split-rows` | Three pages, rows split across both page breaks |
| `european-format` | EUR, comma decimals and dot grouping |
| `broken-math-unmatched` | Two pages: line-math error, net weight above gross, uncatalogued SKU with no origin, row repeated across the page break |

Definitions live in `src/specs.ts`. After changing them, regenerate with
`pnpm --filter @cea/fixtures generate`; a test fails if committed files drift
from the generator.
