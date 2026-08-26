## documentation-vault.md

# Documentation vault (`docs/`)

The project's decisions and memory live in the **vault** — versioned and
navigable — not in any external memory file. This repo is the source of truth.

> **Writes to `docs/` are restricted.** See the prohibitions in `AGENTS.md`:
> propose vault changes and wait for explicit confirmation; never write directly.

## Structure — hybrid domain + type

- `docs/00-overview/` — root map of content (`index.md`), `architecture.md`,
  `system-context.md`, `glossary.md`
- `docs/domains/<service>/{specs,decisions,runbooks,testing}/` — one folder per
  service: `users`, `orders`, `tracking`, `events-pipeline`
- `docs/infrastructure/{specs,decisions,runbooks}/`
- `docs/shared/{decisions,patterns,conventions,observability}/` — **all global
  ADRs live in `shared/decisions/`**
- Global note types at the root: `docs/{lessons,retros,ideas,plans,templates}/`

## Note conventions

- **Cross-cutting rules are defined once in `shared/` and referenced by
  `[[wikilink]]`** — never duplicated into service specs.
- Every note has YAML frontmatter: `title`, `type`, `area`, `status`, `created`,
  `updated`, and `related` where applicable.
  - `type` ∈ `spec`, `adr`, `runbook`, `convention`, `pattern`, `lesson`,
    `retro`, `plan`, `reference`
  - `area` ∈ `users`, `orders`, `tracking`, `events-pipeline`, `infra`, `shared`
  - `status` ∈ `draft`, `active`, `accepted`, `superseded`
- Tags are folder-style: `area/<x>`, `type/<x>`, `status/<x>` (plus
  `severity/<x>` for lessons and `phase/<n>` for phases).
- Filenames: evergreen notes `kebab-case.md`; ADRs `ADR-NNNN-title-kebab.md`
  with continuous global numbering; dated notes `YYYY-MM-DD-short-title.md`.
- Every note ends with a `## Related` section listing its outgoing wikilinks.

## Propagation — a spec is not done when it is written

Design documents under `docs/superpowers/{specs,plans}/` are where decisions are
**made**; the organized vault (`docs/domains/`, `docs/shared/`,
`docs/infrastructure/`, `docs/00-overview/`) is where they **live**.

A spec or plan is done only when its decisions have propagated into the category
folders they belong to. **Before proposing the PR that closes an issue or
milestone**, update or create the target notes, link them bidirectionally, and
bump each target's `updated:`.

Every **new** spec or plan under `docs/superpowers/` declares a `propagates-to:`
frontmatter key listing its target notes, or opts out with
`propagates-to: none — <reason>` (a bare `none` fails validation).

## Validation

`node scripts/validate-vault.mjs` checks frontmatter (required keys **and** valid
`type`/`area`/`status` values), broken wikilinks, and the propagation gate. Run
it after editing vault notes. Notes predating 2026-07-28 are exempt and are
reported as a "Propagation debt" count — that line is the gate working, not
failing.

Two things the validator does **not** catch, so check them by hand:

- **Intra-note anchor links** (`[text](#heading)`). GitHub-style slugs lowercase
  the text, strip punctuation, and hyphenate spaces; an em-dash yields a double
  hyphen. `## Commit messages — Conventional Commits v1.0.0` becomes
  `#commit-messages--conventional-commits-v100`, not `#commit-messages`.
- **Wikilink anchors** (`[[note#Some Heading]]`). Only the note is resolved, so a
  wrong heading passes silently. Re-check these after renaming any heading.

---

## env-files.md

# Env files — generated, never hand-edited

`make env-file` generates **every** env file from Terraform outputs:

- `.env` — only the four variables docker compose interpolates
- `.env.local.infra`
- `.env.local.users`
- `.env.local.orders`
- `.env.local.debug`

None of them is hand-maintained. The local AWS emulator remints resource ids and
reassigns database ports on every apply, so a hand-edited value goes stale
silently.

## The two boxes

Each generated file has:

- an **AUTO-GENERATED** box — rewritten from scratch on every run. Never edit it;
  your change will be gone after the next `make env-file`.
- a **CUSTOM** box — preserved across runs. Put overrides and personal tokens
  here.

## How services consume them

Services read their file through the compose `env_file:` key and declare
**nothing** inline. An inline `environment:` entry silently beats `env_file:`,
which produces a value that ignores the generated one.

Adding a service means adding one env file and one `env_file:` line — nothing
inline.

## Version control

`.env.example` is the committed contract. Everything else matching `.env*` is
git-ignored.

---

## git-and-commits.md

# Git and commit messages

## Never write to git without explicit confirmation

**Never commit, push, merge, or open a pull request without explicit user
confirmation.** Leave finished work in the working tree and ask.

When a git write is warranted:

1. Summarize what is staged.
2. Propose the Conventional-Commits message.
3. Ask the user to choose an action, and wait for their answer.

The available actions are always the same five:

- **A.** Commit + push + create PR — only when the feature/issue is complete
  (PR base by branch type; opened, never merged).
- **B.** Commit + push.
- **C.** Commit only.
- **D.** Continue without committing (leave the work in the working tree and
  carry on).
- **E.** The user writes the commit manually.

Choosing an option **is** the confirmation for that write, and authorizes
**only** that action. It is never standing approval, and never authorizes a
merge.

This rule overrides any tool, skill, or workflow that commits automatically.

**Never auto-merge.** The user merges (or explicitly authorizes the merge of)
every PR; one approval authorizes only that PR or batch.

## Conventional Commits v1.0.0

All commits and PR titles follow <https://www.conventionalcommits.org/en/v1.0.0/>:

```
<type>(<scope>): <description>
```

- **types:** `feat`, `fix`, `build`, `chore`, `ci`, `docs`, `style`, `refactor`,
  `perf`, `test`
- **scope:** the area of the repo — `users`, `orders`, `tracking`,
  `events-pipeline`, `infra`, `vault`, `agents`
- **breaking changes:** use `!` after the scope and/or a `BREAKING CHANGE:` footer

Before proposing a commit or PR, do a **best-effort** lookup of context
references — the tracker issue (if any), the plan, the design spec — and attach
them as footers (`Refs:`, `Closes:`, `Plan:`, `Spec:`, `Design:`) and as a
`## References` section in the PR body. This is enrichment, **never a blocker**:
absence of a reference never stops the commit.

## Branch flow

- Milestone → `feature/<milestone-slug>`, branched off `main`.
- Issue/task → `<type>/<ISSUE-ID>-<slug>`, branched off its feature branch.
- Task PR targets the feature branch (squash-merge; merged branches are
  auto-deleted).
- On milestone completion, **propose** a PR from the feature branch to `main`
  and stop. The user merges after review.

## Batch review and dependency gates

- **Chain issues without per-merge prompts.** Work issues one after another. Do
  not ask for merge confirmation between each issue, and do not self-merge task
  PRs during the chain — leave them open.
- **Batch PRs for review.** At each stop point, present **one list** of open PRs
  to review and merge, never one at a time.
- **Dependency gates are stop points.** If issue B is blocked by A, B must build
  on A's **merged** work. Implement everything independent first, open those
  PRs, then stop and hand over the batch. Continue after the user merges it. A
  milestone may have several stop points.

## Review the diff against the brief, not on its own merits

*"Is this correct?"* and *"does this do everything it was asked to do?"* are
different questions, and **only the first gets asked by default.**

When reviewing, **enumerate the brief's requirements** — the spec, the plan, the
issue, the task description — and tick each one off against the diff. Do not judge
the diff holistically.

A requirement silently dropped during implementation leaves **no trace**. The
shipped code is self-consistent, it passes review on its own terms, and the tests
written alongside it cover **what was built rather than what was specified**. There
is nothing in the diff to notice, which is exactly why a holistic read cannot
catch it.

This is not hypothetical. The cart's concurrent-`PUT` retry was specified in the
design spec from its **first commit**, shipped as an unhandled `500`, passed its
per-task review, and was caught only by chance in a later whole-branch pass.

**Concurrency requirements are the highest-risk case**, since ordinary tests
structurally do not exercise them: a race needs two callers interleaved at a
precise point, so a suite can be complete by its own measure and still never
execute the path the spec was written about.

Full lesson: `docs/lessons/2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec.md`.

---

## language-and-scope.md

# Language and scope

## Language

- **Converse with the user in Spanish.**
- **Write documentation content in English** — note bodies, technical terms,
  filenames, and frontmatter.

The split is deliberate: the conversation is with a Spanish speaker, the
artifacts are read by tooling and by future contributors in English.

When delegating written work to another agent, **name the output language
explicitly**. A Spanish prompt otherwise produces Spanish issues and Spanish
documentation.

## Scope

Stay within what was asked. **No unrequested features, files, or refactors**
(YAGNI).

If you find a real problem outside the requested scope, say so in a sentence and
let the user decide — do not fix it unasked, and do not quietly widen the change
to cover it.

---

## local-emulator-state.md

# Local AWS emulator (Floci) — state must die with its containers

The repo runs a local AWS emulator (Floci) on a single endpoint (`:4566`) as the
`floci` compose service. Terraform's local environment and the service SDKs
target it through `AWS_ENDPOINT_URL`. Lambda and ECS execute as real Docker
containers joined to the compose network.

## State lives in a named volume, on purpose

Emulator state persists in the **`floci-state` named volume** (with
`FLOCI_STORAGE_MODE=persistent`), **not** in a `./data` bind mount.

This is not cosmetic. `docker compose down -v` removes named volumes and
**cannot** remove a bind mount, so under the old layout no teardown command
cleared emulator state — it outlived every `down`.

## Why a stale state is dangerous rather than merely untidy

If the backing containers are removed while the state survives, the emulator
boots, reloads that state, and reports resources as `available` for clusters
whose containers no longer exist. `terraform apply` then asks whether the
resource exists, is told yes, and **creates nothing — while reporting success.**

Nothing fails at that point. The failure surfaces much later and far from its
cause, when a service dials the resource and gets a DNS resolution error for a
container that was never created.

The behavior is **selective**, which is what makes it look intermittent: the
emulator relaunches RDS containers from persisted state at boot, but has no
equivalent reconciler for DocumentDB or ElastiCache. A single teardown can
therefore leave the relational databases healthy and the other two phantom.

## Rules

- **`make clean` runs `docker compose down -v` unconditionally.** It is
  destructive and does **not** prompt. That absence of a prompt is deliberate:
  the old prompt defaulted to *keeping* the state, which is precisely what made
  from-scratch rebuilds non-deterministic. Do not reintroduce a confirmation
  step, and do not offer a "keep the data" option.
- **Never trust a reported `available` status after touching the emulator
  container.** Check `docker ps` for the backing container.
- **`make doctor` cross-checks** every declared DocumentDB/ElastiCache resource
  against `docker ps` and exits non-zero when state and reality disagree. Run it
  when the local stack behaves oddly, before debugging the service that failed.
- **`make bootstrap` is the single supported entry point** for bringing the
  local stack up; a full rebuild is `make clean && make bootstrap`.
- Runtime **state** belongs in named volumes. Files a container merely reads
  (for example a collector config mounted read-only) are **source**, not state,
  and stay bind mounts.

## Recovering a phantom without a full rebuild

Delete the resource through its own API (for example
`aws docdb delete-db-cluster --skip-final-snapshot`, or
`aws elasticache delete-replication-group`), then `terraform taint` the module's
`terraform_data.*_via_cli` resource and re-apply that target.

A plain `-target` apply does **nothing** on its own — the awscli-fallback
resources only re-run when their trigger changes.

## Do not list DocumentDB clusters with `aws docdb describe-db-clusters`

Against this emulator that call returns the **RDS** clusters and omits the
DocumentDB one entirely, so it yields both false phantoms and a missed real
cluster. The generated `DOCDB_HOST` **is** the container name — check that
instead.

---

## logging-and-pii.md

# Logging, tracing, and PII

## Shared cross-service context

Every log line carries the same context fields:

`trace_id`, `cognito_sub`, `user_id`, `email_hash`, `order_id`, `duration_ms`

Unknown fields are **omitted, never null**. A `null` in a log field is
indistinguishable from a bug that failed to populate it.

## Never log

- passwords
- tokens
- full request bodies
- **plaintext email addresses**

Auth flows log a **masked** email (`jo*****e@gmail.com`). Everything else uses
`email_hash`.

## Flow events

Flow logs carry `app_event`, valued `<flow>_started`, `<flow>_succeeded`, or
`<flow>_failed`, plus a `reason` on failures.

There is **no SUCCESS severity** — SUCCESS is not an OpenTelemetry level.
Success is `INFO` plus `app_event=*_succeeded`.

## Which endpoints owe a flow log — READS INCLUDED

**Every endpoint gets a workflow span and at least one flow log. A read is not
exempt.** This was got wrong once, on the strength of an unverified claim that
reads carry no flow logs, so it is worth stating plainly. The *shape* differs
between reads and writes, and that difference is the whole point:

- **Reads** (e.g. `list_my_orders`, `read_cart`) get a span plus **one
  `_succeeded` line carrying a count** — no `_started` twin, no `_failed`
  branch. There is no intermediate step at which `_started` could be the last
  line seen, and the method names no failure of its own: a DB fault throws out
  of the workflow wrapper, which already records it on the span. Inventing a
  `reason` for a branch the code does not have is exactly what this convention
  forbids.
- **Writes** (e.g. `create_order`, `update_cart`, `delete_cart`) get the full
  `_started` / `_succeeded` / `_failed` triad plus `reason` on failures, because
  they *do* have real intermediate steps at which `_started` can be the last
  thing seen.

### Emit the line inside the activity

The `_succeeded` line must be written **inside** the workflow span so it carries
that span's `span_id`. The outer per-request completion line is written under the
framework's own HTTP span and cannot serve a span-scoped log lookup — a query
joining logs to a workflow span will simply not find it.

### Never re-pass identity at a call site

Do not pass `cognito_sub` / `user_id` again where an enricher already attaches
them to every line (in the Orders service, Serilog's `LogContextEnricher`).
Duplicating them is how a PII-adjacent field ends up somewhere nobody audits.
Pass only the count or the flow-specific field.

### Instrument the entry point, not a shared helper

Put the span on the **endpoint's entry point**, not on a helper it happens to
call. A helper reused by the write path — in Orders, `CartReadService.BuildAsync`
renders the response for the write path too — emits a spurious nested *read* span
inside every write when instrumented. The span belongs on `GetMyCartAsync`, the
entry point, not on the shared builder.

## OpenTelemetry configuration lives in environment variables, not code

Endpoint, protocol, and the disabling of the metrics/logs exporters all go in
the standard OTLP environment variables. **Do not configure the SDK in code** —
three separate silent failures in this repo came from exactly that: an
SDK option left `undefined` loses to auto-detection, and nothing reports an
error.

A new service needs no endpoint code at all, only the environment variables.

---

## package-manager.md

# Package manager — pnpm only

**pnpm is the package manager. Never `npm`, never `yarn`** — including for
brand-new sub-projects that do not exist in the workspace yet.

A bare `npm install` corrupts the pnpm tree and leaves a stray
`package-lock.json` sitting beside `pnpm-lock.yaml`, which is the state this rule
exists to prevent. Once both lockfiles exist, the next person to install gets a
different dependency graph than the one that was tested.

## Command translation

| Instead of | Use |
|---|---|
| `npm install` | `pnpm install` |
| `npm install <pkg>` | `pnpm add <pkg>` |
| `npm run <script>` | `pnpm run <script>` |
| `npx <bin>` | `pnpm dlx <bin>` |
| `npm exec` | `pnpm exec` |
| workspace package script | `pnpm --filter <pkg> <script>` |

## A vendor's docs are not an exception

**A vendor's own documentation using `npm` is not a reason to deviate.** Nearly
every upstream README writes its install line as `npm install`; that is the
ecosystem default, not a requirement of the tool. Translate the command using the
table above and carry on.

This is the specific trap: an agent reads `npm install some-tool` in the official
docs, treats it as the tool's supported path, and runs it verbatim. The tool
installs fine — and the workspace is now inconsistent.

## Node version

The repo pins Node via `.nvmrc` (currently **24.18.0**). Activate the pinned
version before any Node or pnpm command:

```bash
nvm use && pnpm install
```

Full convention: `docs/shared/conventions/package-manager.md`.

---

## scripting-language.md

# Scripting language — Python first

- **Python by default** for new scripts: infra scripting, Terraform pre/post
  effects, and anything touching AWS, JSON, or non-trivial control flow.
- **JavaScript** only when the task already lives in the Node ecosystem present
  here (vault tooling, the pnpm workspace, its dependencies). That is why
  `scripts/*.mjs` stay JS.
- **Bash** only with an explicitly documented limitation, recorded in a comment
  inside the script itself. The repo currently has **zero `.sh` files** — keep it
  that way unless you can write down why Bash was unavoidable.

## Running Python

Infra Python scripts run from the repo venv. `make scripts-setup` creates it
(idempotent, and a prerequisite of every apply target). Terraform and the
Makefile invoke `.venv/bin/python` by **absolute path** — never plain `python3`
off `PATH`, which may resolve into an unrelated venv.

## Shared helpers

Shared helpers live in `infra/scripts/lib3mrai/` (`aws.py`, `console.py`,
`db.py`). Do not duplicate boto3 client setup or console helpers. Scripts stay
**colocated** with the Terraform module that invokes them.

## Node.js version

The repo pins Node via `.nvmrc` (currently **24.18.0**). Activate the pinned
version before running any Node command (`node`, `pnpm`, `pnpm dlx`, global
installs). With nvm: `nvm use && node scripts/validate-vault.mjs`.

The package manager is **pnpm — never `npm` or `yarn`**. Full rule:
`.ai/rules/package-manager.md`.

---

## testing.md

# Testing — three layers per endpoint

Every new or changed HTTP endpoint requires **all three** layers before it is
done:

1. **Unit / integration** — the handler and its collaborators.
2. **Internal E2E** — against the service URL directly.
3. **Gateway E2E with a real Cognito JWT** — the URL the user actually hits.

## Why the third layer is not optional

In-process and internal tests fake the authorizer and never touch the API
gateway, so they cannot see gateway-only bugs:

- a route that was never registered on the gateway
- a path parameter dropped in the gateway mapping
- an HTTP method mismatch between gateway and service

An endpoint without gateway E2E is an **incomplete change**, not a change
pending a nice-to-have.

Per-service specifics live in each `services/<svc>/CLAUDE.md` (or the equivalent
service instruction file), section 2b.

## A NEW ROUTE IS NOT DONE WHEN THE SERVICE SERVES IT

A plan that adds an endpoint must carry a task for **each** item below, or state
why one does not apply. Every one of them was missed at least once (cart
milestone, 2026-08-25) and each was caught late — or nearly not at all.

### Gateway + nginx wiring

Two separate places route a request before it reaches your handler, and neither
fails loudly:

- A route absent from the gateway's route map
  (`infra/modules/api-gateway/main.tf`) **404s at the gateway** while working
  perfectly on the service port.
- Without a `location` block in `infra/modules/compute/nginx/nginx.conf`, a new
  top-level path falls through to `location /` and silently reaches **Users** —
  not the service that owns it. It answers; it is simply the wrong service.

**Diagnostic:** a 404 carrying the gateway's own `{"message":"Not Found"}` body,
rather than the service's `{error: …}` shape, means the request never reached the
service at all. Read the body, not just the status.

**After the fix, a 401 is the good answer.** It proves the route resolves and got
as far as the authorizer. Do not read it as a regression.

### All three test layers, not two

**Internal E2E is the one quietly skipped**, because the gateway spec feels like
it covers the same ground. It does not: the gateway spec is slower and should not
carry the exhaustive cases, so dropping the internal layer silently drops the
exhaustive coverage with it.

### Load-test scenarios

Required when the route changes how users reach an **existing** flow — a new
entry point to a covered journey leaves the old simulation measuring a path real
users no longer take.

### Observability

Every endpoint owes a workflow span and at least one flow log. **Reads are not
exempt** — see `.ai/rules/logging-and-pii.md`, "Which endpoints owe a flow log".

### Preview surfaces and rounding

A preview surface must mirror **how the charging code applies rounding**, not
merely how it rounds. Matching the rounding function while applying it at a
different point (per line vs. per total) still quotes a price the charge will not
match. See `docs/shared/conventions/money-representation.md`.

## Load testing is a fourth, different surface

Load tests live in `e2e/load-tests/` (Gatling JS + Chance.js), beside the
Playwright suite in `e2e/`. They answer a **different question**: not "is it
correct?" but "what shape does it have under sustained traffic?".

They are **not** interchangeable with E2E specs, and reading one as the other is
the common mistake — percentiles over four E2E requests are noise, and a load run
proves nothing about correctness beyond status codes.

### The two E2E-only headers, and why load tests omit them

- **`x-e2e-source: true`** tags rows so cleanup can delete exactly what a run
  created. It only takes effect when the flag `E2E_TESTING_ENABLED` is **also**
  on — that conjunction is what stops an untrusted client tagging someone else's
  rows for deletion.
- **`x-test-mode: true`** (on order creation) makes a tracking advance itself
  every 10s to DELIVERED, so a delivery flow can be asserted in ~40 seconds.

**Load simulations deliberately send neither.** Their data is meant to persist
like real data (reset with `make clean && make bootstrap`, not a cleanup pass),
and without `x-test-mode` a tracking does not self-advance — which is why a
simulation drives it through the **carrier webhook**, the way a real carrier
does.

### Load-simulation traps (measured, not guessed)

- **Use `session.userId()`, never a module-level counter**, for anything that
  must be unique per virtual user. Simulation modules are evaluated per execution
  context, so module scope is not one shared sequence — a counter produced the
  *same* email five times in one run. The cascade is what makes it expensive: a
  duplicate email 409s registration, login then fails, and every authenticated
  step after it 401s, so one data bug reads as a broken auth chain.
- **`process.env` does not exist** in a simulation — use
  `getEnvironmentVariable` / `getParameter` from `@gatling.io/core`. With
  `@types/node` present the former type-checks and then dies at runtime.
- **A 409 on order creation is expected under load** — creation locks each
  product row `FOR UPDATE`, so concurrent buyers genuinely contend. Accept
  201-or-409 and guard the steps needing an order id.
- **Give each virtual user its own token.** A shared one collapses every
  user-scoped read onto a single `cognito_sub` and hides the per-user query cost.
- **Isolate slow dependencies behind their own request name**, so an inbox poll
  measured in seconds never smears a service's real ~26ms latency.
- **Assert only on our own endpoints** — holding a third party's latency to a
  budget fails the run for something the simulation does not measure.

### Never run a load simulation and the E2E suite against the same stack

Not a style preference — it makes **every email-asserting spec fail**, and the
failure looks exactly like a broken pipeline. Diagnosed 2026-08-25, after five
E2E failures (4× OTP/password-reset, 1× tracking DELIVERED) that were all this
one environmental cause.

The mechanism, because the rule alone is not enough to recognise it:

- A load run publishes several hundred `loadtest-*` events onto the **shared**
  SQS queue — the same one Users, Orders and Tracking use.
- The events-pipeline Lambda drains it at **~0.83 msg/s** (~50 msg/min). Records
  are processed **sequentially** (`for (const record of event.Records)` in
  `functions/events-pipeline/src/handler.ts`), ~**376 ms** each (p50 347, p95
  574, over 920 records), dominated by the react-email render on a **256 MB**
  function — Lambda CPU scales with memory.
- So an OTP, reset, or DELIVERED event published behind ~800 messages waits
  **~13 minutes**, while every spec awaiting an email gives up after **45 s**.

**The emails are not lost — they arrive far too late.** This is the part worth
remembering, and the reason the rule is written out rather than stated: the
timeout reports *"NOTHING arrived"*, which reads as a broken pipeline and sends
you hunting a defect in dispatch, SES, or Mailpit. All three are fine. Verified
by re-running the same specs with **no code change in between**:

| Queue depth | Result |
|---|---|
| ~800 | 2 failed — "NOTHING arrived within 45s" |
| 0 | **14/14 passed**, emails in **13 s** |

Measured drain, sampled live: `827 → 727 → 567 → 417 → 237 → 0` over ~18 min.

`e2e/support/global-setup.ts` **warns** when the backlog exceeds
`EVENTS_QUEUE_WARN_DEPTH`; the arithmetic lives in
`e2e/support/events-queue-depth.ts`. **If you see that warning, wait for the
queue to drain or reset with `make clean && make bootstrap`** — do not start
debugging the pipeline.

Three properties of that check are deliberate, and worth preserving if you touch
it:

- **It warns, it never fails.** It cannot tell an email-asserting run from the
  majority of specs that never touch the pipeline, and blocking those would turn
  a narrow problem into a total one.
- **It is silent when the depth cannot be read** (returns `null`, never `0`). A
  diagnostic that can itself fail a run is worse than the problem it reports.
- **The threshold is derived, not picked round** — 45 s budget − 13 s healthy
  delivery = 32 s headroom, × 0.83 msg/s ≈ 26, rounded **down** to 25 so the
  warning fires slightly early. If the Lambda's per-record cost or concurrency
  changes, **redo the arithmetic; do not nudge the constant.**

## Mocks hide schema bugs

Mocked unit tests pass happily while the real schema or driver rejects the
write. Verify persistence paths against a live database, not only a mock.

## Assertions must name what they saw

Count-only assertions ("got 3 of 4") cannot distinguish a broken system from a
wrong expectation. Print **what** arrived, not just how many.

---

## vault-over-memory.md

# GOLDEN RULE — the vault is the source of truth, never a private memory file

When the user establishes a **convention**, a **decision**, or a **durable
lesson**, it goes into the **vault** first:

- `docs/shared/conventions/` — how we do a thing
- `docs/shared/decisions/` — an ADR, why we chose it
- `docs/lessons/` — a gotcha that cost real debugging time

Writing it **only** to an assistant memory store is **wrong**, and is the exact
failure mode this rule exists to prevent.

## Why

The vault is versioned, reviewable in a pull request, readable by every human and
every agent on the project, and it survives independently of any one assistant's
memory. A private memory file is:

- **invisible to the team** — nobody can see what you recorded
- **unreviewable** — it never appears in a diff
- **silently divergent** — it drifts from the repo with nothing to catch it

**A rule the user had to state twice, because the first capture was invisible to
them, is a rule that was not captured.**

This applies to *whatever* memory feature you happen to have — a rules file, a
memory tool, a saved-context store, a scratch note only you can read. If the
record lives somewhere the user cannot review in a PR, it does not count as
recorded.

## Order of operations

1. **Vault note first** — with `## Related` wikilinks, and the validator green.
2. *Then*, optionally, a short memory pointer if it genuinely helps recall
   mid-session.

**Never memory instead of the vault. Never memory before it.**

## What counts as durable

Not just the big architectural calls. Also: the package-manager choice, a naming
convention, a gotcha that cost debugging time, a workflow correction.

The test: **"would a teammate need to know this next month?"** If yes, it belongs
in `docs/`.

## Rules files vs. project knowledge

Agent instruction files (this one, `AGENTS.md`, and the per-directory rules) are
for **rules that govern agent behaviour**. The vault is for **project
knowledge**. A convention usually deserves both: the note in `docs/`, and a
one-line pointer in the instructions when it changes how work is done.

## Writing to the vault

**You do not write to `docs/` directly.** See the prohibition in `AGENTS.md`:
propose the note and wait for explicit user confirmation. The golden rule tells
you *where the knowledge must end up* — it does not grant you write access to
get it there.
