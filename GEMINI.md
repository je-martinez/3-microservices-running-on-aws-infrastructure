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

## OpenTelemetry configuration lives in environment variables, not code

Endpoint, protocol, and the disabling of the metrics/logs exporters all go in
the standard OTLP environment variables. **Do not configure the SDK in code** —
three separate silent failures in this repo came from exactly that: an
SDK option left `undefined` loses to auto-detection, and nothing reports an
error.

A new service needs no endpoint code at all, only the environment variables.

---

## scripting-language.md

# Scripting language — Python first

- **Python by default** for new scripts: infra scripting, Terraform pre/post
  effects, and anything touching AWS, JSON, or non-trivial control flow.
- **JavaScript** only when the task already lives in the Node ecosystem present
  here (vault tooling, the pnpm workspace, npm dependencies). That is why
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
version before running any Node command (`node`, `npm`, `npx`, global installs).
With nvm: `nvm use && node scripts/validate-vault.mjs`.

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

## Mocks hide schema bugs

Mocked unit tests pass happily while the real schema or driver rejects the
write. Verify persistence paths against a live database, not only a mock.

## Assertions must name what they saw

Count-only assertions ("got 3 of 4") cannot distinguish a broken system from a
wrong expectation. Print **what** arrived, not just how many.
