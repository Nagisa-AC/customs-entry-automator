# Customs Entry Automator — System Design

Oct 20, 2026 · @Ibrahim Kebbeh · last updated Oct 21, 2026

The living reference for the production system. The v0 CLI design covers tonight's build; this doc covers what it grows into. Update the decision log whenever a design choice changes.

## Principles

1. The model extracts; code decides. Deterministic code normalizes, reconciles, validates and decides whether export is allowed.
2. Every important value has provenance: source document, page and region when available, extraction run, and every later edit or approval.
3. Value states stay distinct: extracted, catalog-matched, suggested, manually edited and approved are never blurred.
4. No unresolved blocking issue reaches an exportable state.
5. Processing is versioned and replayable. Retries are idempotent; reprocessing creates a new traceable run.
6. Tenant isolation at every boundary: application, database, queue and object storage.
7. Boring infrastructure: one app, one worker, one Postgres, one object store, one queue.

## Scope & non-goals

The system prepares broker-reviewed entry data; it never files an entry or replaces the broker's judgment.

### In scope for the first workflow

- Upload commercial invoices as supported PDFs; packing lists when the workflow needs them.
- Extract line items and selected header fields into a versioned schema.
- Normalize values, preserve source evidence, run deterministic arithmetic and completeness checks.
- Match products against importer-specific approved catalog mappings under explicit rules.
- Review interface with source context, discrepancy explanations and attributable approvals.
- Generic CSV first; a native export only after a broker supplies and validates the format.

### Non-goals

- Filing or transmitting customs entries.
- Guaranteeing legal correctness of classification, valuation, origin or admissibility.
- Replacing the broker's system of record or recordkeeping obligations.
- Supporting every layout, filing platform, adjustment type or jurisdiction at launch.
- Treating model confidence, schema validity or passing arithmetic as proof a value is correct.

Unsupported or ambiguous cases are marked for human resolution, never coerced into a supported path.

## Architecture

Documents flow left to right through five stages; the only data that leaves our infrastructure is page content sent to the model provider for extraction.

*(Diagram in the source doc: system architecture · 5 stages, 3 stores.)*

### Components

A modular monolith: one Next.js app plus one separately running worker, sharing a TypeScript codebase. Tech choices marked proposed are open in the decision log.

| Component | Responsibility | Tech |
|---|---|---|
| Web app | Upload, review grid with PDF viewer, catalogs, user and admin settings, export download | Next.js App Router, TypeScript, React, Tailwind, PDF.js |
| Application/API | Authorization, document creation, signed upload/download, review and approval commands | Next.js server routes/actions; shared domain package |
| Auth & orgs | Users, broker orgs, memberships, roles, MFA | Clerk |
| Billing | Plans, usage metering by invoice count (after M5) | Stripe |
| Inbound email | Per-org forwarding address (after the core pipeline is proven) | Postmark or Resend inbound (proposed) |
| Object storage | Original documents, rendered pages if retained, export artifacts | Private S3 bucket, US region, least-privilege IAM |
| Queue | Durable jobs, retries, backoff, concurrency limits | pg-boss on the same Postgres (no job data leaves our infrastructure) |
| Worker | Extraction and deterministic pipeline stages; records retries and failures | Node.js + TypeScript, separate process |
| Extraction adapter | Provider-neutral interface for vision-model extraction with structured output | Provider SDKs behind one interface; zero-retention terms, US region |
| Rules engine | Normalization, decimal math, reconciliation, completeness and policy checks | TypeScript + decimal.js, versioned rule set |
| Exporters | Map approved normalized data to a tested target format | Pure, versioned TypeScript modules |
| Database | Tenant records, stage state, catalogs, check results, approvals, audit events | PostgreSQL + Prisma, migrations, RLS |
| Observability | Errors, stage timings, queue health, cost and quality metrics | Structured logs; Sentry (US region, content scrubbing required); metrics and alerts |

## Data model

Every table except `Org` carries `orgId`; Postgres row-level security enforces it as a second layer behind application checks.

| Table | Key fields | Invariants |
|---|---|---|
| Org | id, name, plan, retentionDays, filingSystem | Tenant root; no cross-org identifiers through authorization shortcuts |
| Membership | orgId, userId, role, status | Membership and role checked on every protected operation; revocation takes effect promptly |
| Importer | id, orgId, name, external identifiers | Belongs to exactly one org |
| CatalogItem | id, orgId, importerId, sku, aliases, description, hts10, provenance, approvedBy, approvedAt, version, validity | One SKU is not assumed to map to one timeless classification; explicit matching rules; unique (importerId, sku, version) |
| Document | id, orgId, importerId, type, fileKey, contentHash, status, currentRevisionId | Original file immutable; a replacement creates a new revision |
| DocumentRevision | documentId, revision, source metadata, pageCount, createdBy, createdAt | Identifies the exact source being processed |
| ProcessingRun | documentRevisionId, model and prompt version, ruleSetVersion, catalogSnapshot, status | New logic or catalog snapshot means a new run |
| PageArtifact | processingRunId, pageIndex, rawExtractionKey, renderKey | Scoped by tenant and retention policy; stored for replay |
| ExtractedField | fieldPath, value, sourceType, page, bbox, processingRunId | Field-level provenance for important values |
| Line | documentRevisionId, sourceLineKey, sku, description, qty, unitPrice, extendedPrice, origin, hts10, htsSource, status | Decimal columns; source and normalized forms both kept; no unexplained missing or duplicate lines |
| CheckResult | processingRunId, lineId?, ruleId, ruleVersion, severity, outcome, expected, actual, evidence | Blocking findings resolved or explicitly dispositioned before export |
| ReviewDecision | target, actor, decision, reason, before, after, at | Tied to a specific revision and run |
| ExportArtifact | documentRevisionId, processingRunId, exporterVersion, fileKey, hash, createdBy | Immutable; generated only from eligible approved inputs |
| AuditEvent | orgId, actor, action, target, at, details | Append-only; privileged mutation restricted and monitored |

### Domain fields to define before claiming support

- **Money:** currency, source precision, rounding policy; treatment of discounts, freight, insurance and taxes.
- **Quantity:** original quantity, unit of measure, allowed conversions.
- **Classification:** HTS value, schedule version or effective date, source, approval history, re-review triggers.
- **Origin:** country of origin kept separate from supplier location and ship-from country.
- **Weights and packages:** gross and net weight, package count, unit, reconciliation status.
- **Documents:** invoice number and date, type, currency, packing-list relationship, importer identity.

The first release declares exactly which fields and adjustment types it supports; anything else blocks or routes to review.

The catalog is the product's moat: every approved line feeds `CatalogItem`, so match rates rise with use.

## Job lifecycle

States: `received` → `queued` → `extracting` → `normalizing` → `validating` → `needs_review` or `ready_for_approval` → `approved` → `exported`. `failed` and `cancelled` are explicit states. Transitions are validated in the database and application layer.

### Data flow

1. The user uploads a file; the app checks org access, file type, size and page limits, hashes the file, stores it and creates a document record.
2. A durable job is enqueued through a transactional outbox, in the same transaction as the document record.
3. The worker creates a processing run, renders or parses pages, and calls the extraction adapter only for the content needed.
4. Extraction output is schema-validated, stored as an immutable artifact, then normalized and stitched across pages.
5. Deterministic checks, cross-document reconciliation and catalog matching produce explicit findings.
6. A reviewer resolves blocking findings and approves values with an attributable audit trail.
7. The exporter creates an immutable artifact only from an approved revision and records every version involved.

### Stage execution rules

- Every stage records an idempotency key, attempt count, input and output artifact versions, start and end times, and a structured failure reason.
- Duplicate queue delivery never creates duplicate results, approvals, audit events or exports.
- A retry repeats the same stage on the same versioned inputs. A replay after a code, prompt, model, rules or catalog change creates a new `ProcessingRun`.
- State updates use transactions with expected-state checks, so a stale worker can't overwrite newer state.
- Only classified transient errors retry. Invalid input and exhausted retries end in a visible failure with a remediation path.
- A check still failing after one bounded re-extraction stays blocking until an authorized reviewer resolves it.
- Catalog changes during a run don't change that run's inputs; the run records its catalog snapshot.
- Exports bind to one approved revision and run. Later edits create a new revision and never change an existing export.

### Reliability patterns

- Unique database constraints enforce idempotency keys and stage outputs, not only application checks.
- Bounded worker concurrency, provider timeouts, page count, token usage, retries and total cost per document.
- Exhausted jobs land in a reviewable failure state with a safe operator retry path.
- Cancellation and supersession are explicit, including a file replaced while an older run is processing.
- `failed` is reachable from any stage after retries are exhausted and always shows the reason in the UI.

## Extraction, validation & review

Model output is untrusted input: it can't approve values, change catalogs, trigger exports or take any external action.

**Extraction contract:** the adapter takes a source artifact and configuration and returns schema-constrained candidate fields, line items, page references and source regions. Raw and normalized output are stored as separately versioned artifacts under retention policy, with provider, model, prompt and schema versions plus cost and latency, never invoice contents in application logs.

| Layer | Examples | Behavior |
|---|---|---|
| Structural | Required fields, types, allowed values | Reject malformed output; never coerce silently |
| Arithmetic | qty × unit price vs. extended price; defined rounding | Record discrepancy and severity |
| Reconciliation | Line sums vs. invoice total; invoice vs. packing-list quantities, packages, weights | Explain the mismatch and link source evidence |
| Completeness | Missing, duplicated or unexplained lines; page continuity | Blocking where completeness can't be established |
| Semantic | Currency, unit, origin and classification semantics | Reject unsupported values; route ambiguity to review |
| Catalog | SKU and alias match, importer scope, mapping staleness | Separate candidate matches from approved mappings |
| Export eligibility | Blocking findings resolved, required fields approved, revision current | Deny export until satisfied |

Every `CheckResult` carries rule ID and version, severity, outcome, evidence, expected and actual values where meaningful, and a plain remediation message. A passing check is evidence for that rule only.

### Human review

- Each important field shown beside its source evidence.
- Extracted, catalog-matched, suggested, edited and approved values visually distinct.
- Explicit approval required for inferred or changed values and every blocking finding.
- Actor, time, revision, run, field, prior and new value recorded, with a reason where required.
- Model-reported confidence is not treated as a probability; thresholds only after measuring error rates on labeled data.

## Security & data handling

Invoices expose supplier pricing and importer relationships, which is what brokers will ask about first.

### Trust boundaries

- **Browser → app:** authenticated sessions, authorization on every operation, CSRF protection, rate limits, safe upload handling.
- **App/worker → database:** least-privilege credentials, tenant-scoped queries, RLS as defense in depth, tests for privileged roles and connection pooling.
- **App/worker → object storage:** short-lived signed URLs, server-side ownership checks, private buckets, least-privilege IAM; never rely on key prefixes alone.
- **Worker → model provider:** send only required content; verify processing region, retention, training terms, subprocessors and contract before any live data.
- **Inbound email (when enabled):** recipient-org binding, sender authorization, message and attachment limits, duplicate detection, malware scanning, quarantine.
- **App/worker → Sentry:** error reports scrubbed of request bodies, local variables and breadcrumbs that could hold invoice content; US data region.

### Customs-specific obligations

- **US data residency (default, confirm with counsel):** brokers must keep original records, including electronic ones, inside US customs territory (19 CFR 111.23). How that applies to a processor is a legal question, but US-only is cheap now and painful to retrofit, so database, object store, queue, backups, logs, error reporting and the model provider's processing region are all US-only unless counsel says otherwise. Confirm each provider offers a US region before choosing it.
- **System-of-record boundary:** brokers must keep entry records at least 5 years. The contract states the broker's filing system holds the originals and we are a processing tool, not an archive. Brokers can download documents and exports before retention deletion.
- **Record confidentiality:** Part 111 includes a records-confidentiality section (§ 111.24). A trade attorney reviews whether sending invoice pages to a model provider is compatible with it, before the first paying customer.
- **Subprocessors:** signed DPA with the model provider; a published subprocessor list (cloud, model provider, error reporting, email, auth, billing) customers are notified before it changes.
- **Legal review before production:** customs recordkeeping, confidentiality, data location and the customs-business boundary, confirmed in customer contracts and DPAs. This doc records design defaults, not legal conclusions.

### Tenant isolation & access

- `orgId` on every row, enforced by Prisma middleware and Postgres RLS; object keys prefixed by org; signed URLs that expire in minutes.
- MFA required for every user through Clerk; roles: admin (settings, catalogs, users) and reviewer (review, export).
- Sessions expire after inactivity.
- Our own access to customer data is break-glass only: requires a stated reason, is logged to `AuditEvent`, and is visible to the customer.

### Untrusted input

- **Inbound email:** accept only from addresses the org has allow-listed; check SPF/DKIM; reject attachments that aren't PDF, xlsx or csv; size cap per file.
- **PDF parsing:** in the worker only, in a sandboxed subprocess with time and memory limits.
- **Prompt injection:** the model has no tools and can only return schema-validated JSON. Injected text can at most falsify values, which still face the math rules and human review. Model output never triggers actions.
- **XSS:** extracted text is always escaped in the review UI, never rendered as HTML.
- **CSV injection:** text fields starting with `=`, `+`, `-` or `@` are escaped in exports so they can't run as spreadsheet formulas.

### Encryption, secrets & supply chain

- TLS 1.2+ on every connection; encryption at rest on the database, object store and backups.
- Secrets in the environment, rotated, never in the repo; least-privilege database and bucket roles per process.
- Lockfile committed, dependencies pinned, automated vulnerability scanning in CI.

### Retention, backups & logs

- Raw PDFs, page images, intermediate artifacts and temp files deleted after `retentionDays` (default 30, confirm with counsel); lines, catalog and audit log kept for the life of the account; provider-side data deleted where the contract allows.
- Deletion jobs are observable and retryable; the deletion boundary and backup expiry are documented honestly.
- Daily encrypted backups in a US region; restore tested monthly; deleted data ages out of backups within 35 days.
- Logs and error reports never contain invoice contents, SKUs, prices or party names; only opaque ids, stages and outcomes. A test throws an error on a real-shaped document and asserts nothing sensitive reaches Sentry.

### Incident response & assurance

- One-page incident response plan: who investigates, how evidence is preserved, and notice to affected brokers within 72 hours of confirming a breach.
- `AuditEvent` export so brokers can use it in their own reasonable-care records.
- A written security summary of this section for broker questionnaires now; SOC 2 once paying customers require it.

## Reliability, observability & evals

The eval set is the most important asset after the catalog: no model, prompt or rule change ships without running it.

### Eval harness

A labeled set of representative and difficult invoices with broker-verified expected results where feasible, split by supplier or document family so near-duplicates don't leak between development and held-out tests. Runs in CI on any change to prompts, adapters, normalization, rules or exporters; results stored per run.

| Metric | Definition |
|---|---|
| Silent-error rate | Wrong critical values that pass every check and reach an export-eligible state; the metric that matters most |
| Line-item recall | Expected rows captured; shows omissions |
| Line-item precision | Captured rows that are real source rows; shows invented or duplicate rows |
| Critical-field accuracy | Quantity, price, currency, origin and classification, measured separately |
| Reconciliation detection | Share of planted or labeled inconsistencies correctly flagged |
| Export correctness | Field and row match against broker-approved expected output |
| Review effort | Human corrections and review time per document or line |
| Cost and latency | Per page and document; provider failures and retry rate |

### Test layers

- Unit tests for decimal math, normalization, catalog matching, each rule and each exporter.
- Golden-fixture regression tests, including hard layouts and multi-page stitching.
- Adversarial tests: wrong quantities and prices, omitted or duplicated rows, misleading totals, inconsistent packing lists.
- Property-based tests for totals, idempotency, version binding and export eligibility.
- Integration tests for queue retries, duplicate delivery, concurrent edits, tenant isolation, object permissions and deletion.
- End-to-end tests from upload through approval and export.
- Restore and incident-response exercises before relying on backups.

**Release policy:** no model, prompt, normalization, rule or exporter change ships without a recorded eval run. Numeric thresholds come after a labeled baseline exists and risk tolerance is agreed with brokers. Minimum gate: no unresolved blocking findings on exportable documents, no known silent critical-field errors in release fixtures, exporter contract tests pass, regressions reviewed. Every confirmed production error becomes a regression case where the customer permits, otherwise a sanitized reproduction.

### Observability

| Signal | Examples |
|---|---|
| Pipeline health | Queue depth and age, stage latency, stuck jobs, retries, failure counts |
| Provider health | Error and timeout rate, fallback frequency, cost per page, latency |
| Quality | Review rate, blocking-check distribution, silent-error findings, catalog match rate per org |
| Security | Denied cross-tenant access, abnormal downloads, auth failures, break-glass access |
| Storage and lifecycle | Retention deletion lag, failed deletions, object access errors, backup and restore status |

- **Alerts:** sustained queue age, provider error spikes, failed retention jobs, any cross-tenant denial, backup failures.
- **Runbooks:** provider outage, queue backlog, failed document, bad deployment, suspected data exposure, restore.
- **Failure handling:** provider outage falls back to a second provider behind the same adapter; a document never silently drops, it ends in `ready`, `needs_review` or `failed` with a reason.

## Export integrations

Every exporter is a pure function from validated lines to a file; none is built until a paying broker on that system hands over a sample import file.

| Filing system | First format | Later | Status |
|---|---|---|---|
| Generic | CSV, one row per line | — | v0 |
| NetCHB (Descartes) | Their invoice-line import file | — | Needs a broker's sample file |
| Magaya | Their import template | — | Needs a broker's sample file |
| GoFreight | Their import template | — | Needs a broker's sample file |
| CargoWise | File import | eAdaptor push | Needs a sample; API access terms unverified |

Format details for each system are unverified until we have a real sample; don't build from public guesses.

### Export contract

- Generic CSV is a development artifact, not proof of compatibility with any filing platform.
- Each exporter is a deterministic function from one approved normalized-data version to bytes plus a manifest: revision, run, rule set, catalog snapshot, exporter and template version, output hash, creator.
- Contract tests: headers, order, encoding, delimiters, quoting, blank fields, number and date formats, leading zeros, Unicode, multiline text, file limits.
- Security tests: formula injection and hostile source strings.
- Semantic tests compare every field and row against broker-approved expected output; import tests in a filing-system test environment where available.
- No exporter bypasses the common export-eligibility gate.

## Deployment & environments

- **Local:** Docker Compose for Postgres; local-only sample documents; mocked extraction provider for deterministic tests.
- **CI:** type checks, lint, unit tests, migration checks, exporter contracts, dependency and security scanning, eval suite.
- **Staging:** separate database, bucket, credentials and provider config; synthetic or approved sanitized documents only.
- **Production:** web and worker deployed separately from one repo; least-privilege service identities; private storage; controlled migrations; alerting; tested backups; US region.
- Customer data and secrets never copied into developer environments or CI artifacts without an approved, documented reason.

## Implementation plan

Broker outreach starts alongside M1, using the CLI and the outreach-phase handling rules below (see "Handling real broker files during outreach"). Don't wait for M2 to learn whether brokers care.

Each milestone below is broken into ordered tasks. Each task should be one reviewable piece of work: describe the approach, agree, then build in small diffs. A milestone is done only when its exit criterion is met, not when its task list is.

| Milestone | Deliverable | Exit criterion |
|---|---|---|
| M1 — CLI pipeline (+ outreach starts) | PDF ingestion, extraction adapter, normalized schema, provenance, deterministic checks, CSV | Runs on a small labeled set; reproducible; errors visible |
| M2 — Eval baseline | Gold fixtures, metrics, adversarial cases, regression command in CI | Failure modes measured; release criteria written |
| M3 — Broker workflow proof | Protected sample handling, review UI, explicit approvals, one real export template | A broker validates output and shows measurable time savings |
| M4 — Production foundation | Tenant isolation, durable jobs, versioned runs, retention and deletion, monitoring, recovery | Security tests and runbooks pass |
| M5 — Paid pilot | One filing-system workflow, onboarding, usage metering, support | Customer accepts the workflow and pays |

### M1 — CLI pipeline (+ outreach starts)

**Goal:** run any invoice PDF and an importer's SKU→HTS sheet through a TypeScript CLI and get a CSV plus a report of every check. No web app, auth, billing or database.

#### M1 scope

```sh
cea run invoice.pdf --skus skus.xlsx
```

Code lives in the private customs-entry-automator repo: a pnpm workspace with `packages/core` (schema, normalizer, rules, extraction adapter, exporters) and the `cea` CLI app. The web app and worker import core unchanged in M3. This doc is exported to `docs/system-design.md` in the repo whenever it changes, so coding agents build from the current version.

- **In:** multi-page commercial invoices (text PDFs and scans), line-item extraction, SKU lookup, math and weight checks, CSV and report export.
- **Out until a broker asks:** packing-list merging, native filing-system formats, AI HTS suggestions for unknown SKUs, currency conversion, review UI.

#### M1 data contracts

The model returns numbers as strings exactly as printed; the normalizer converts them, so a misread stays visible instead of being silently rounded.

| Field | Type | Notes |
|---|---|---|
| `invoiceNumber`, `invoiceDate`, `sellerName`, `buyerName` | string | Header |
| `currency`, `incoterms` | string | Header |
| `invoiceTotal`, `totalGrossWeight`, `totalNetWeight` | string | As printed, with unit |
| `lines[].sku`, `description`, `countryOfOrigin` | string | Per line |
| `lines[].quantity`, `unitPrice`, `extendedPrice` | string | As printed |
| `lines[].page` | number | Source page, carried into every finding |

**Normalized output:** the same fields with numbers as decimal.js values, weights with a unit, and SKUs trimmed and uppercased. The decimal format (`1.234,56` vs `1,234.56`) is detected once per document from all its numbers, never per number.

**SKU catalog** (xlsx or csv): columns `sku`, `hts10`, `description`. Exact match on trimmed, uppercased SKU; no fuzzy matching in M1.

#### M1 validation rules

All arithmetic uses decimal.js, never JS floats. Each rule emits a `CheckResult`: rule ID, severity, outcome, row, page, expected, actual, and a plain-language message.

Any fail blocks `lines.csv`: the CLI writes `lines.review.csv` with affected rows marked `needs_review` and exits 1. R6 checks page boundaries only; the same SKU twice on one page can be a legitimate order. Invoices with freight or discount lines fail R2 and go to review, since M1 doesn't support adjustments; track how often this happens. To track it, `report.json` carries a heuristic `adjustments` counter, which is not a rule: it lists probable adjustment lines (no SKU, or a description matching freight, shipping, discount, rebate, insurance, surcharge, fee or charge terms) and records whether R2 failed on the same document. The extraction prompt asks the model to skip freight and discount rows, so the counter mainly catches rows that were extracted anyway; an R2 failure with no counted lines may still be an unextracted adjustment.

R2 is the extraction canary: when it fails, assume a row was missed or misread before blaming the invoice. The rounding tolerances are a starting guess; revise them once real broker invoices show how suppliers round.

| ID | Rule | Check | Severity on miss |
|---|---|---|---|
| R1 | Line math | quantity × unitPrice = extendedPrice, within $0.01; a missing extendedPrice fails | Fail |
| R2 | Footer total | sum of extendedPrice = invoiceTotal, within $0.01 × line count | Fail |
| R3 | Weights | totalNetWeight ≤ totalGrossWeight; fails if only one weight has a unit; warns if weights aren't printed (often only on the packing list) | Fail / Warn |
| R4 | SKU match | SKU found in catalog; a line with no HTS can't be filed | Fail (stays in review) |
| R5 | Required fields | Every line has SKU, quantity, unit price and origin | Fail |
| R6 | Duplicate lines | Last row before a page break vs. first row after it: same SKU and price | Warn (likely a split row) |
| R7 | Page continuity | Every page from 1 to the page count produced a valid extraction, none missing or failed; no page or line references a page beyond the page count; no row split across a page break is left unmerged | Fail |

#### M1 decisions

| Decision | Choice | Trade-off |
|---|---|---|
| Model | Provider-neutral `extract()`; benchmark 2–3 current vision models on the labeled set | An hour of benchmarking vs. building around the wrong model |
| Page handling | One page per call, stitched in code | Scales to 50-page invoices; rows split across pages need merge logic |
| Text layer vs. vision | Send the page image and any embedded text | Text fixes digit misreads on clean PDFs; scans fall back to image only |
| Retries | Deferred to M2: build re-extraction on R2 failure only if the eval set shows it fixes misreads | Avoids building retry logic before seeing real failure patterns |
| Output | Generic CSV only; `lines.review.csv` when any rule fails | Native formats need a real sample file from a broker |
| Anthropic structured output | `output_config.format` with type `json_schema`; generated schema sets `additionalProperties: false` and has no numeric or string-length constraints | The older `output_format` parameter and beta header only work for a transition period |

#### M1 outputs

Each stage writes to the `--out` folder (default `.cea-out/<invoice-name>/`) so any stage can be replayed without calling the model again; `cea run --from <stage>` re-runs from that stage using the saved outputs of earlier ones.

- `pages/` — rendered page images (`page-001.png`) and extracted text layer (`page-001.txt`), plus `manifest.json` with page count and hashes
- `extract/` — per page, the raw model response (`page-001.raw.json`, with provider, model, prompt version and cache key) and the schema-validated extraction or failure (`page-001.json`), plus `manifest.json` with each page's status
- `stitched.json` — pages merged into one line list, with split rows joined
- `normalized.json` — stitched, normalized document
- `checks.json` — results of the document rules (R1–R3, R5–R7)
- `matched.json` — lines after SKU catalog matching, with the R4 results
- `report.json` — every `CheckResult`, pass or fail, the document status, the versions used, and the `adjustments` counter
- `lines.csv` — one row per line when there are no blocking findings; text fields starting with `=`, `+`, `-` or `@` escaped
- `lines.review.csv` — written instead of `lines.csv` when any finding is a fail, with affected rows marked `needs_review`; a stale `lines.csv` from an earlier run is removed

#### M1 tasks

**Deterministic core (no model calls)**

1. Repo setup: pnpm workspace with `packages/core` and `apps/cli`; strict TypeScript, Vitest, Zod, decimal.js, lint; CI runs tests on every push.
2. Extraction schema: Zod types for header and line fields; numbers kept as raw printed strings; page number on every line.
3. Normalizer: decimal format detected once per document; strings parsed to decimals; SKUs trimmed and uppercased; unit tests for each format.
4. Validation rules: the M1 rules R1–R7, each returning rule ID, severity, row, page, expected and actual; tests prove each rule fires on a broken copy and passes on a clean one.
5. Test data: synthetic invoices (clean, multi-page with split rows, European format, and a broken copy) with SKU sheet and ground-truth JSON; 2–3 public samples with hand-written ground truth.

**Model and file handling**

6. PDF loading: render pages to images and read any text layer, in a subprocess with time and memory limits.
7. Extraction adapter: `extract()` interface; first provider; one call per page; output validated against the schema; raw output saved per page.
8. Stitching: merge pages into one line list; detect rows split across page breaks and duplicates. A split row that can't be merged fails R7; a repeated row across a page break warns under R6.
9. Catalog matching: load the SKU sheet (xlsx or csv); exact match on normalized SKU; unmatched rows flagged.
10. Export: `lines.csv` with formula-character escaping; `report.json` listing every check with row and page.
11. CLI command: wires the stages; each stage writes its output to disk; any stage can be replayed without re-calling the model.
12. Second provider: same interface; compare field accuracy, cost and latency on the labeled set; record the choice in the decision log.

**Parallel track (no code):** build a 50–100 broker lead list (NetCHB, Magaya, GoFreight shops first) and start outreach; real files follow the handling rules below.

**Done when:** the whole labeled set runs end to end, repeat runs on cached extractions give identical output, and every failure shows up in the report.

#### Handling real broker files during outreach

Real broker invoices run through this CLI on a laptop before any production safeguards exist, so they get production-level care from the first file.

- Files live only on an encrypted disk (FileVault or equivalent), one folder per broker, outside the repo; `samples/real/` is in `.gitignore`.
- Real files never sit inside any folder an AI coding tool (Cursor, Claude Code) can read, since those tools send workspace contents to their model providers. The tool's ignore file is a second layer, not the only one.
- Model API calls use zero-retention terms and a US processing region; no other service sees the files.
- Delete the broker's files and outputs within 7 days of returning results, or sooner on request, and tell them when it's done.
- Never add a broker's invoice to the eval set without their written permission.
- Offer the NDA before they send anything; accept redacted files.
- Return outputs only to the address that sent the file.
- Keep a log: broker, file received date, deleted date.

### M2 — Eval baseline

**Goal:** measure accuracy so no change ships blind.

1. Fixture structure: one folder per invoice with source file, ground truth and metadata; split into development and held-out sets by supplier family.
2. Adversarial fixtures: wrong line math, omitted rows, duplicated rows, misleading footer totals, packing-list mismatches.
3. Scorer: compares pipeline output to ground truth; computes silent-error rate, line recall and precision, per-field accuracy, reconciliation detection, cost and latency.
4. `eval` command: runs the set and saves a report tagged with model, prompt, rule and exporter versions.
5. CI gate: eval runs on any change to prompts, adapters, normalizer, rules or exporters, and fails on regression.
6. Property-based tests: totals, idempotency of stages, rule determinism.
7. Baseline write-up: record baseline numbers, known failure modes and draft release criteria in this doc.

#### M2 fixture format

```
fixtures/<supplier-family>/<fixture-id>/
  source.pdf   # or .xlsx / .csv
  truth.json   # same shape as normalized.json, human-verified
  meta.json    # see below
```

- `meta.json`: supplier family, layout tags (scanned, multi-page, split rows, European decimals), origin (synthetic, public, broker-permitted), split (`dev` or `heldout`), and for broker files the written-permission reference.
- **Split rule:** every fixture from one supplier family goes in the same split, so near-duplicate layouts never leak from development into held-out.
- **Size:** start with 20 fixtures, grow toward 50 before setting numeric release thresholds (proposed).
- Adversarial fixtures are copies of clean ones with one planted fault each, recorded in `meta.json` as the expected finding: wrong line math, omitted row, duplicated row, footer total off, net weight above gross, packing-list mismatch.

#### M2 scoring definitions

- **Line alignment:** predicted lines are matched to truth lines by SKU, then page, then position on the page. Unmatched truth lines count as missed; unmatched predicted lines count as invented.
- **Critical fields:** `sku`, `qty`, `unitPrice`, `extendedPrice`, `currency`, `countryOfOrigin`, `hts10`.
- **Silent error:** a critical field that's wrong on a line with no fail-severity finding on that line or its document. Warnings don't excuse a wrong value, because a warned line still reaches `lines.csv` and can be exported. This is the headline metric.
- **Field accuracy:** exact match after normalization, reported per field.
- **Reconciliation detection:** share of planted faults that produce the expected finding.
- **Cost and latency:** per page and per document, from the extraction adapter's recorded usage.

#### M2 eval runs and CI

- `cea eval --split heldout` writes `evals/runs/<timestamp>-<git-sha>.json` with every metric plus model, prompt, rule and exporter versions, and a short markdown summary.
- Extraction results are cached by (file hash, provider, model, prompt version), so CI only pays for model calls when the adapter or prompt changes; rule and normalizer changes re-score cached extractions for free.
- **CI gate:** fails if the silent-error count rises, if any planted fault stops being detected, or if any metric drops beyond a tolerance set from the baseline run.
- Baseline numbers, known failure modes and release criteria are written into this section when M2 finishes.

**Done when:** baseline numbers are recorded, failure modes are listed, and CI blocks regressions.

### M3 — Broker workflow proof

**Goal:** one real broker uses the output on live entries. **Needs first:** a broker who has tested files and agreed to pilot, and a sample import file from their filing system.

**Security minimum before any live data enters the web app:** single org only, MFA on, US-region hosting, encryption at rest and in transit, no invoice content in logs or Sentry, private bucket with signed URLs, CSV and UI escaping, and the trade-attorney review of § 111.24. The full production controls come in M4, but this floor is not optional.

1. Web app shell: Next.js, Clerk with MFA, one org; no billing.
2. Database: Prisma schema for the data model tables; `orgId` on every tenant table from day one.
3. Upload and processing: upload stores the file and runs the core pipeline through a simple job runner (durable queue comes in M4).
4. Catalog management: upload an importer's SKU sheet; view and edit mappings.
5. Review UI: PDF.js viewer with source highlights, line grid with value states colored, findings with remediation messages, edit and approve with reasons recorded.
6. Export gate: export is denied until blocking findings are resolved and required values approved.
7. Native exporter: built from the broker's sample file, with contract tests; the broker confirms it imports into their system.
8. Time study: measure manual entry time vs. time with the tool on the same invoices.

#### M3 decisions to make at the start

These depend on the pilot broker, so they're decided when M3 begins and recorded in the decision log before any code:

- Which filing system and import workflow the pilot uses.
- Hosting provider and US region for the app, worker, database and bucket.
- Which fields and adjustment types are in scope for this broker; everything else blocks.
- Who at the broker can approve catalog mappings.

#### M3 screens

| Screen | What it does |
|---|---|
| Documents | List with status, importer, upload date, open findings count; upload button with importer picker |
| Review | PDF on the left with source highlights; line grid on the right; findings panel; header fields; approve and export actions |
| Catalog | Per importer: upload a SKU sheet, search, edit a mapping, see who changed what and when |
| Export | Download the approved export and its manifest; list of past exports per document |

#### M3 review rules

- Every value shows its state as a labeled badge, not color alone: extracted, catalog-matched, suggested, edited, approved.
- Clicking a cell highlights its source region on the PDF page.
- Editing a critical field requires a reason; the before and after values, actor and time go to `ReviewDecision` and `AuditEvent`.
- Findings are resolved one of two ways: fixed (an edit makes the rule pass) or accepted with a written reason by an admin.
- An HTS entered for an unmatched SKU applies to that line only, unless the reviewer explicitly chooses "save to catalog," which creates a `CatalogItem` with source `approved-from-review`.
- Any edit re-runs validation for that document; a new revision is created if the document was already approved.

#### M3 export gate

Export is allowed only when all of these hold:

- No unresolved fail-severity findings.
- Every line has an HTS that is catalog-matched or approved.
- Every critical field is approved or catalog-matched.
- The revision being exported is the current one.

#### M3 native exporter

1. Get one real export or import sample from the broker's filing system, plus their field mapping if they have one.
2. Write the mapping into this doc: every target column, its source field, format rules and blanks.
3. Build the exporter as a pure function with contract tests from the sample.
4. The broker imports a test file into their system and confirms it worked; record the date and who confirmed.

#### M3 time study

Pick 10 representative invoices with the broker. Their entry writer times manual entry on 5 and tool-assisted entry (upload, review, export, import) on the other 5, then swaps on a second set if time allows. Record minutes per invoice and per line. Under 75% savings triggers the kill criterion.

**Done when:** the broker validates output on live entries and time savings are measured (the kill criterion is under 75% savings).

### M4 — Production foundation

**Goal:** safe to run multiple brokers' data.

1. Tenant isolation: Prisma middleware plus Postgres RLS policies; tests that cross-tenant reads, writes and exports fail.
2. Durable jobs: pg-boss, transactional outbox, idempotency keys with unique constraints, expected-state transitions, retries on transient errors only, visible failure states.
3. Versioned runs: document revisions, processing runs bound to catalog snapshots, replay, cancellation and supersession.
4. Storage: private S3 in a US region, short-lived signed URLs, least-privilege IAM.
5. Retention: deletion jobs for raw files and intermediates; observable and retryable.
6. Backups: daily encrypted US backups; a restore actually tested.
7. Security controls: CSRF, rate limits, sandboxed parsing limits, escaping tests, break-glass access, secrets rotation, dependency scanning.
8. Observability: structured logs, Sentry scrubbing and leak test, metrics, alerts from the observability table.
9. Operations: staging environment, runbooks, incident response plan.
10. Legal and assurance: customer contract, DPA, subprocessor list, ToS, written security summary.

The full controls are specified in the Security & data handling and Job lifecycle sections; this is how M4 implements them.

#### M4 tenant isolation

- Every request and job opens a transaction that runs `SET LOCAL app.org_id = '<orgId>'`; RLS policies on every tenant table allow rows only where `org_id = current_setting('app.org_id')`.
- The app's database role cannot bypass RLS; migrations run under a separate role.
- Prisma middleware also adds `orgId` to every query, so a missing policy fails twice before data leaks.
- Tests: for each tenant table, a second org's user tries to read, update, delete and export the first org's rows and gets nothing; a job with the wrong `org_id` fails; signed URLs for another org's objects are refused.

#### M4 jobs and outbox

- Outbox table: `id`, `orgId`, `jobType`, `payload` (ids only, never invoice content), `idempotencyKey` (unique), `createdAt`, `dispatchedAt`. Written in the same transaction as the state change; a dispatcher moves rows into pg-boss.
- Queues: one per stage (`extract`, `normalize`, `validate`, `export`, `retention`), each with its own concurrency limit.
- Retries: transient errors only (timeouts, rate limits, provider 5xx), at most 3 attempts with exponential backoff; everything else goes straight to `failed` with a reason.
- State transitions: `UPDATE ... WHERE id = ? AND status = <expected>`; zero rows updated means another worker won, and the job exits without side effects.
- Tests: duplicate delivery of every job type, a worker killed mid-stage, two concurrent edits to the same document, cancellation while extracting, a replaced file while an older run is processing.

#### M4 retention, backups and environments

- Retention job runs daily, deletes raw files and intermediates past `retentionDays`, logs counts per org, and alerts on failure.
- Database backups are daily and encrypted in a US region; one full restore into a scratch environment is performed and timed before M4 closes.
- Staging mirrors production with separate database, bucket, credentials and provider keys, and holds only synthetic or approved sanitized documents.

#### M4 legal and documents

- Trade attorney review complete: § 111.24 confidentiality, model-provider processing, data location, customs-business boundary.
- Customer contract, DPA, subprocessor list and ToS drafted from that review.
- One-page security summary for broker questionnaires, written from the Security section.
- Incident response plan and runbooks written: provider outage, queue backlog, failed document, bad deploy, suspected exposure, restore.

**Done when:** isolation, integration and security tests pass, a restore has succeeded, runbooks exist, and counsel has signed off.

### M5 — Paid pilot

**Goal:** a broker pays for the workflow.

1. Onboarding: set up a new broker org, importers and catalogs (manual is fine).
2. Billing: Stripe subscriptions and usage metering by invoice count.
3. Support: a channel, a response-time commitment, and a process for failed documents.
4. Commercial terms: contract and DPA signed; Founding pricing for the first 5 brokers.

#### M5 onboarding checklist

1. Contract, DPA and ToS signed.
2. Org created; admin invited with MFA enforced.
3. Importers created; each importer's SKU sheet uploaded and spot-checked with the broker.
4. Filing-system exporter confirmed with one test import.
5. Retention setting confirmed in writing.
6. A first live invoice processed together on a call.

#### M5 billing

- Stripe products for Starter, Pro and Founding tiers.
- Usage counted once per new document revision that completes processing; retries, replays and reviewer edits don't count (proposed).
- Usage visible to the broker in-app; overage handling decided before the first invoice is sent.

#### M5 support

- One support email plus a shared channel if the broker uses one.
- Response within one business day; a failed document that blocks an entry gets a same-day response.
- Every support issue that reveals a bug or extraction miss becomes a regression fixture where the customer permits.

**Done when:** the customer accepts the workflow and pays.

No billing, inbound email, multiple exporters or self-serve onboarding until the core pipeline is proven useful and reliable.

## Open questions before live customer data

- Which filing system and import workflow does the first pilot support?
- Which fields and adjustment types are in scope, and which cases are rejected or manual?
- What minimum eval set is representative enough to set release thresholds?
- Which model provider meets accuracy, latency, cost, US-region and contract requirements?
- What retention schedule applies to originals, page images, intermediates, exports, logs and backups?
- What legal review covers confidentiality, recordkeeping, data processing and the service boundary?
- Who can approve classification mappings, and what triggers re-review?
- What acceptance test proves a native export is usable?

## Terminology

| Term | Meaning |
|---|---|
| Extracted | Candidate value read from a source document |
| Normalized | Value in canonical form, source preserved |
| Catalog-matched | Value tied to an existing mapping under configured rules |
| Suggested | Inferred or proposed, not yet approved |
| Approved | Explicitly accepted by an authorized reviewer for a specific revision and run |
| Blocking finding | Unresolved issue that prevents export |
| Processing run | Versioned pipeline execution against one revision and configuration |
| Gold fixture | Test document with a human-verified expected result |

## Decision log

Add a row whenever a design choice is made or reversed; mark the old row superseded rather than deleting it.

| Date | Decision | Why | Status |
|---|---|---|---|
| 2026-10-20 | TypeScript for web app and worker | One language solo; Python PDF tooling revisited only if evals show text-layer extraction matters | Accepted |
| 2026-10-20 | Modular monolith: Next.js app plus separate TypeScript worker | Simplest thing that separates request handling from long-running jobs | Proposed |
| 2026-10-20 | Queue: pg-boss on our Postgres, not hosted Inngest | No job data passes through another vendor or region | Proposed |
| 2026-10-20 | Document revisions and processing runs bound to a catalog snapshot | Every export traceable to exact inputs, rules and model | Proposed |
| 2026-10-20 | Sentry with content scrubbing, US region, and a leak test | Error reports capture request data by default | Proposed |
| 2026-10-20 | Broker outreach runs alongside M1, not after M2 | The business fails on demand before it fails on design | Proposed |
| 2026-10-20 | US-only data and processing by default, including model provider, backups and error reporting; confirm with counsel | 19 CFR 111.23 keeps broker records in US customs territory; cheap now, costly to retrofit | Proposed |
| 2026-10-20 | We are a processing tool, not the broker's system of record | Brokers must keep entry records 5 years | Proposed |
| 2026-10-20 | Trade attorney reviews § 111.24 confidentiality and model-provider processing before first paid customer | Unknown whether third-party processing is permitted | Proposed |
| 2026-10-20 | Model has no tools; output is schema-validated JSON only | Limits prompt injection to falsified values, which rules and review catch | Proposed |
| 2026-10-20 | Escape formula characters in CSV exports; escape all extracted text in the UI | Invoice text is attacker-controlled | Proposed |
| 2026-10-20 | MFA required for all users; break-glass logging for our own access | Broker data is commercially sensitive | Proposed |
| 2026-10-20 | Security summary now; SOC 2 when paying customers require it | Cost and time before revenue | Proposed |
| 2026-10-20 | LLM extracts only; all math in TypeScript with decimal.js | Models misadd long columns; floats misround money | Proposed |
| 2026-10-20 | Model behind one `extract()` adapter, chosen by eval | Avoid lock-in; models change monthly | Proposed |
| 2026-10-20 | Page-by-page extraction, stitched in code | Scales to long invoices, isolates failures | Proposed |
| 2026-10-20 | Generic CSV before any native format; native exporters only from a broker's real sample | No compatibility claim without broker validation | Proposed |
| 2026-10-20 | First target: brokers on NetCHB, Magaya, GoFreight | Funded competitors focus on CargoWise | Proposed |
| 2026-10-20 | Raw files deleted after 30 days by default; confirm with counsel | Limits exposure of supplier pricing | Proposed |
| 2026-10-21 | R7 page continuity also fails on extractions or lines that reference a page beyond the page count, and on split rows left unmerged | Each of these means lines may be missing or wrong, so completeness can't be established | Accepted |
| 2026-10-21 | M1 output layout: `pages/`, `extract/`, `stitched.json`, `normalized.json`, `checks.json`, `matched.json`, `report.json`, and `lines.csv` or `lines.review.csv` | One saved artifact per stage, so `--from <stage>` can replay any stage without re-calling the model | Accepted |
| 2026-10-21 | `report.json` carries a heuristic adjustment-line counter (no SKU, or freight, discount, insurance or charge terms) and whether R2 failed; not a rule | Measures how often unsupported adjustments cause R2 failures before deciding on adjustment support | Accepted |
| 2026-10-21 | Silent error: only a fail-severity finding excuses a wrong value; warnings don't. The M2 scorer is aligned to this | A warned line still reaches `lines.csv` and can be exported | Accepted |
