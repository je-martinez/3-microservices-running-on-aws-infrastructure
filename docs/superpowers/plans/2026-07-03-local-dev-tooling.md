---
title: Local Dev Tooling (Makefile + .http files) — Plan
type: plan
area: shared
status: draft
created: 2026-07-03
updated: 2026-07-03
tags: [type/plan, area/shared, status/draft]
related: ["[[2026-07-03-local-dev-tooling-design]]", "[[ADR-0017-floci-local]]", "[[git-workflow]]"]
---

# Local Dev Tooling (Makefile + .http files) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a root `Makefile` that orchestrates the local dev lifecycle (docker-compose + Terraform-on-Floci) and a `services/users/users.http` REST Client file to exercise the users endpoints, plus a documented convention for adding one `.http` per service.

**Architecture:** Developer tooling only — no service business logic. The Makefile wraps `docker compose` and `terraform -chdir=…/spike-floci`. The `.http` file is self-contained (file-level `@baseUrl` + response capture). One additive `docker-compose.yml` edit publishes the `users` port so `localhost:3000` is reachable. Conventions/README go through the `obsidian-vault` agent for `docs/`; root files are edited by the main session.

**Tech Stack:** GNU Make, Docker Compose v2, Terraform (Floci-targeted spike), VS Code REST Client (`humao.rest-client`), Markdown/YAML frontmatter, `scripts/validate-vault.mjs` (Node under `nvm use`).

## Global Constraints

- **Developer tooling only** — no changes to service business logic. (spec: Summary, Non-goals)
- **Branch:** `chore/local-dev-tooling` (already created, off `feature/users-service`). One PR. **No Linear issue.** (spec: Summary)
- **Writes under `docs/` go through the `obsidian-vault` agent**; the main session never edits `docs/` directly. (repo rule; spec: Write ownership)
- **Terraform target is `infra/environments/local/spike-floci`** (the Floci-targeted spike with real `providers.tf`), NOT `spike`. (spec: Components, Open questions)
- **`.http` files are committed** (not gitignored — verified). (spec: Components)
- **Only `users` gets a `.http` now.** orders/tracking/events-pipeline get the **convention** only. (spec: Non-goals)
- **No `.vscode/` REST Client environments** — file-level variables + response capture. (spec: Non-goals)
- **Vault content in English; Node commands under `nvm use` first.** (repo rules)
- **`validate-vault.mjs` does NOT check intra-note anchors** — verify by hand. (CLAUDE.md Validation)
- **Commit confirmation via the A/B/C/D/E menu** rendered with `AskUserQuestion`; never commit unprompted. (CLAUDE.md; [[git-workflow]])

---

## Reference facts (verified from the codebase — use these exact values)

Users endpoints (`services/users/src/features/users/http/routes.ts`), listens on `PORT=3000`:
- `GET /v1/health` → `{ "status": "ok" }`
- `POST /v1/users/register` → returns a `User` (see shape below), body = `RegisterInput`
- `POST /v1/users/login` → returns `{ idToken, accessToken }`, body = `{ email, password }`
- `GET /v1/users/me` → uses the `x-user-id` request header as the actor (via the `onRequest` hook); returns the `User` or 404
- `PATCH /v1/users/me` → uses `x-user-id`; body = `UpdateProfileInput`

Shapes:
- `RegisterInput` = `{ email: string, password: string, fullName: string, address?: unknown, phoneNumber?: string, e2eSource: boolean }`
- `UpdateProfileInput` = `{ fullName?: string, address?: unknown, phoneNumber?: string }`
- `User` (register/me response) includes `id: string` (nano-id) — **this `id` is what `/me` and `/patch` expect in the `x-user-id` header.**

Identity model for the `.http` flow: the API Gateway authorizer normally forwards the identity as the `x-user-id` header. Locally there is no gateway, so we capture the `id` returned by **register** and pass it as `x-user-id` on the authenticated requests. (`login` is exercised as its own request to prove the auth endpoint, but its tokens are not what `/me` consumes.)

docker-compose facts: `users` service has no `ports:` today; `floci` publishes `4566:4566`. Floci health: poll `http://localhost:4566` until it answers.

---

## File Structure

| File | Action | Writer | Responsibility |
| --- | --- | --- | --- |
| `Makefile` | Create | main session | Self-documenting targets: compose, infra (Terraform/Floci), orchestration. |
| `docker-compose.yml` | Modify | main session | Publish `users` port `3000:3000` to the host. |
| `services/users/users.http` | Create | main session | REST Client requests for the users endpoints (health→register→login→me→patch). |
| `README.md` | Modify | main session | Short "Local development" note → `make help` + the convention. |
| `docs/shared/conventions/local-dev.md` | Create | `obsidian-vault` | Convention: Makefile targets, one-`.http`-per-service, how to run REST Client. |
| `docs/00-overview/index.md` | Modify | `obsidian-vault` | Index the new convention note in the MOC. |

**Ordering:** Task 1 (compose port) unblocks reaching `users` on the host. Task 2 (Makefile) is independent. Task 3 (`.http`) depends on the port (Task 1) to be testable. Task 4 (convention note, `obsidian-vault`) references the Makefile + `.http` so it comes after. Task 5 (README) is a small pointer. Task 6 validates + hands off.

---

### Task 1: Publish the `users` port in docker-compose

**Files:**
- Modify: `docker-compose.yml` (the `users:` service block)

**Writer:** main session.

**Interfaces:**
- Produces: `users` reachable at `http://localhost:3000` from the host (consumed by Task 3's `.http` and Task 6's curl check).

- [ ] **Step 1: Add the `ports` mapping to the `users` service**

In `docker-compose.yml`, in the `users:` block (which currently has `build:`, `networks:`, `environment:`, `develop:` but no `ports:`), add a `ports` key. Insert it right after the `networks: [3mrai-network]` line:

```yaml
  users:
    build:
      context: .
      dockerfile: services/users/Dockerfile
    networks: [3mrai-network]
    ports:
      - "3000:3000"
```

Leave every other line of the `users` block unchanged.

- [ ] **Step 2: Verify compose still parses**

Run:
```bash
docker compose config --quiet && echo "compose OK"
```
Expected: `compose OK` (no YAML/schema error). If `docker compose` needs the stack env, this only validates syntax — that is enough here.

- [ ] **Step 3: Confirm the mapping is present**

Run:
```bash
docker compose config | grep -A2 "published:" | grep -E "3000|4566"
```
Expected: shows both `3000` (users, new) and `4566` (floci, pre-existing) as published ports.

- [ ] **Step 4: Commit** (propose via the A/B/C/D/E menu — do NOT commit unprompted)

Proposed message:
```
build(users): publish container port 3000 to the host for local dev
```

---

### Task 2: Create the self-documenting Makefile

**Files:**
- Create: `Makefile` (repo root)

**Writer:** main session.

**Interfaces:**
- Produces: targets `help` (default), `up`, `down`, `logs`, `build`, `ps`, `infra-init`, `infra-plan`, `infra-up`, `infra-down`, `infra-output`, `bootstrap`, `clean`. Consumed by the convention note (Task 4) and README (Task 5).

- [ ] **Step 1: Write the Makefile**

Create `Makefile` with exactly this content:

```makefile
# Local development orchestration for 3MRAI.
# Run `make help` (the default) to list targets.
# Two layers: docker-compose (Floci + services) and Terraform against Floci.

COMPOSE      := docker compose
TF_LOCAL_DIR := infra/environments/local/spike-floci
TF           := terraform -chdir=$(TF_LOCAL_DIR)
FLOCI_URL    := http://localhost:4566

.DEFAULT_GOAL := help

.PHONY: help up down logs build ps infra-init infra-plan infra-up infra-down infra-output bootstrap clean

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

## --- Docker Compose ---

up: ## Start the stack (Floci + services) in the background
	$(COMPOSE) up -d

down: ## Stop the stack
	$(COMPOSE) down

logs: ## Tail logs (optional: make logs S=users)
	$(COMPOSE) logs -f $(S)

build: ## Build service images
	$(COMPOSE) build

ps: ## Show container status
	$(COMPOSE) ps

## --- Terraform (against Floci) ---

infra-init: ## terraform init (spike-floci)
	$(TF) init

infra-plan: ## terraform plan (spike-floci)
	$(TF) plan

infra-up: ## terraform apply -auto-approve (spike-floci)
	$(TF) apply -auto-approve

infra-down: ## terraform destroy -auto-approve (spike-floci)
	$(TF) destroy -auto-approve

infra-output: ## Show terraform outputs (Cognito IDs, etc.)
	$(TF) output

## --- Orchestration ---

bootstrap: up ## Bring everything up: compose, wait for Floci, then apply infra
	@echo "Waiting for Floci at $(FLOCI_URL) ..."
	@for i in $$(seq 1 30); do \
		if curl -sf -o /dev/null "$(FLOCI_URL)"; then echo "Floci is up."; break; fi; \
		if [ $$i -eq 30 ]; then echo "Floci did not become ready in time." >&2; exit 1; fi; \
		sleep 1; \
	done
	$(MAKE) infra-init
	$(MAKE) infra-up

clean: ## Tear down infra + compose (prompts before removing ./data)
	-$(TF) destroy -auto-approve
	$(COMPOSE) down
	@printf "Remove ./data (local emulator state)? [y/N] "; read ans; \
		if [ "$$ans" = "y" ] || [ "$$ans" = "Y" ]; then rm -rf ./data && echo "removed ./data"; else echo "kept ./data"; fi
```

- [ ] **Step 2: Verify `make help` is the default goal and lists targets**

Run:
```bash
make
```
Expected: prints the target list (help/up/down/logs/build/ps/infra-*/bootstrap/clean) with descriptions, sorted, colorized. No target actually executes.

- [ ] **Step 3: Verify a dry-run of a target resolves variables correctly**

Run:
```bash
make -n infra-plan
```
Expected: prints `terraform -chdir=infra/environments/local/spike-floci plan` (proves `TF`/`TF_LOCAL_DIR` expand correctly) without running it.

- [ ] **Step 4: Verify the bootstrap poll command is well-formed**

Run:
```bash
make -n bootstrap
```
Expected: shows the `docker compose up -d`, the Floci-wait loop, and the two `$(MAKE) infra-init` / `$(MAKE) infra-up` recursive calls. (Dry run; nothing executes.)

- [ ] **Step 5: Commit** (propose via the A/B/C/D/E menu)

Proposed message:
```
build(infra): add self-documenting Makefile for local dev (compose + Floci terraform)
```

---

### Task 3: Create `services/users/users.http`

**Files:**
- Create: `services/users/users.http`

**Writer:** main session.

**Interfaces:**
- Consumes: `users` on `http://localhost:3000` (Task 1).
- Produces: a runnable REST Client file; `register` is `# @name register` so `/me` and `/patch` reference `{{register.response.body.$.id}}` for the `x-user-id` header.

- [ ] **Step 1: Write the `.http` file**

Create `services/users/users.http` with exactly this content:

```http
### Users service — local REST Client requests (VS Code humao.rest-client).
### Bring the stack up first: `make up` (users is published on :3000).
### Run a request by clicking "Send Request" above it. Run Register before
### the authenticated requests so `{{register.response.body.$.id}}` is populated.

@baseUrl = http://localhost:3000

### Health
GET {{baseUrl}}/v1/health

### Register a new user  (captures `id` for the authenticated requests below)
# @name register
POST {{baseUrl}}/v1/users/register
Content-Type: application/json

{
  "email": "dev@example.com",
  "password": "Passw0rd!",
  "fullName": "Dev User",
  "phoneNumber": "+10000000000",
  "e2eSource": false
}

### Login  (exercises the auth endpoint; returns { idToken, accessToken })
# @name login
POST {{baseUrl}}/v1/users/login
Content-Type: application/json

{
  "email": "dev@example.com",
  "password": "Passw0rd!"
}

### Get me  (identity via x-user-id = the id returned by Register)
GET {{baseUrl}}/v1/users/me
x-user-id: {{register.response.body.$.id}}

### Update me
PATCH {{baseUrl}}/v1/users/me
Content-Type: application/json
x-user-id: {{register.response.body.$.id}}

{
  "fullName": "Dev User (edited)",
  "phoneNumber": "+10000000001"
}
```

- [ ] **Step 2: Verify the file is syntactically sane for REST Client**

Run:
```bash
grep -c "^###" services/users/users.http && grep -n "@name\|x-user-id\|{{baseUrl}}\|{{register.response.body.\$.id}}" services/users/users.http
```
Expected: 5 request separators; the `@name register`/`@name login` directives, both `x-user-id` headers referencing `{{register.response.body.$.id}}`, and the `@baseUrl` references are present.

- [ ] **Step 3: Confirm `.http` is not gitignored (will be committed)**

Run:
```bash
git check-ignore services/users/users.http; echo "exit=$?"
```
Expected: `exit=1` (git check-ignore prints nothing and exits 1 when the path is NOT ignored → good, it will be tracked).

- [ ] **Step 4: (Runtime smoke, best-effort) if the stack is up, health should answer**

Run:
```bash
curl -sf http://localhost:3000/v1/health || echo "stack not up (run 'make up' first) — file is still correct"
```
Expected: `{"status":"ok"}` if the stack is running; otherwise the fallback message (the file is validated by Steps 2–3 regardless).

- [ ] **Step 5: Commit** (propose via the A/B/C/D/E menu)

Proposed message:
```
test(users): add REST Client .http for local endpoint testing
```

---

### Task 4: Create the `local-dev.md` convention note

**Files:**
- Create: `docs/shared/conventions/local-dev.md`

**Writer:** `obsidian-vault` agent (main session must NOT write under `docs/`).

**Interfaces:**
- Consumes: the Makefile targets (Task 2) and the `.http` convention (Task 3).
- Produces: `[[local-dev]]` referenced by the README (Task 5) and indexed in the MOC (added in this task's second file? no — indexing is Task-4 Step 2 via the same agent).

- [ ] **Step 1: Dispatch `obsidian-vault` to create the note**

Note body to write (the agent normalizes frontmatter/tags/wikilinks to vault rules):

```markdown
---
title: Local Development
type: convention
area: shared
status: active
created: 2026-07-03
updated: 2026-07-03
tags: [type/convention, area/shared, status/active]
related: ["[[ADR-0017-floci-local]]", "[[local-dev-ministack]]", "[[git-workflow]]"]
---

# Local Development

How to run the stack locally and exercise service endpoints.

## Makefile

The root `Makefile` orchestrates local dev across two layers — docker-compose
(Floci + services) and Terraform applied against Floci. Run `make help` for the
list. Key targets:

- **Compose:** `make up` / `make down` / `make logs` (`make logs S=users` to scope) /
  `make build` / `make ps`.
- **Infra (Terraform against Floci):** `make infra-init` / `make infra-plan` /
  `make infra-up` / `make infra-down` / `make infra-output`. These target
  `infra/environments/local/spike-floci` — the current Floci spike (see
  [[ADR-0017-floci-local]]); repoint when a consolidated `local` environment exists.
- **Orchestration:** `make bootstrap` (compose up → wait for Floci → apply infra) and
  `make clean` (tear down, prompts before removing `./data`).

## Testing endpoints with `.http` files

Endpoints are exercised with the VS Code **REST Client** extension
(`humao.rest-client`). Install it, open a service's `.http` file, and click
**"Send Request"** above a request.

**Convention: one `.http` per service, added as the service is built.** The file
lives next to the service code and is named after it:

- `services/users/users.http` — exists today.
- `services/orders/orders.http`, `services/tracking/tracking.http`, … — add each when
  that service gains real endpoints. Follow the same shape (a file-level `@baseUrl`,
  `###`-separated requests, and named requests like `# @name register` so later
  requests can reference captured response fields, e.g.
  `{{register.response.body.$.id}}`).

For a service to be reachable from the host, its container port must be **published**
in `docker-compose.yml` (`ports: - "3000:3000"` for users). Add the same mapping when
a new service needs local testing.

## Related

- [[ADR-0017-floci-local]]
- [[local-dev-ministack]]
- [[git-workflow]]
```

- [ ] **Step 2: Dispatch `obsidian-vault` to index the note in the MOC**

Add a list item to `docs/00-overview/index.md` alongside the other shared conventions (match the exact sibling style — capital start, trailing period):
```
- [[local-dev]] — Running the stack locally (Makefile) and testing endpoints with `.http` files.
```

- [ ] **Step 3: Validate the vault**

Run:
```bash
nvm use && node scripts/validate-vault.mjs
```
Expected: PASS. `[[local-dev]]`, `[[ADR-0017-floci-local]]`, `[[local-dev-ministack]]`, `[[git-workflow]]` all resolve.

- [ ] **Step 4: Commit** (propose via the A/B/C/D/E menu)

Proposed message:
```
docs(vault): add local-dev convention (Makefile + .http per service)
```

---

### Task 5: Add a Local development note to the README

**Files:**
- Modify: `README.md` (root)

**Writer:** main session.

**Interfaces:**
- Consumes: `make help` (Task 2), the convention note (Task 4).

- [ ] **Step 1: Read the README to find a sensible insertion point**

Run:
```bash
grep -nE "^#|^##" README.md
```
Identify where a "Local development" section fits (after any existing setup/overview heading; otherwise append near the top-level usage area).

- [ ] **Step 2: Add a short Local development section**

Insert this section (adjust the surrounding blank lines to match the file's style):

```markdown
## Local development

Run `make help` for the local dev commands. In short: `make up` starts the stack
(Floci + services), `make bootstrap` also applies the local Terraform against Floci,
and each service ships a `.http` file (e.g. `services/users/users.http`) you can run
with the VS Code REST Client extension. Full convention:
`docs/shared/conventions/local-dev.md`.
```

- [ ] **Step 3: Commit** (propose via the A/B/C/D/E menu)

Proposed message:
```
docs: point README at make help and the local-dev convention
```

---

### Task 6: Final validation and integration handoff

**Files:** none (verification only).

- [ ] **Step 1: Vault validation**

Run:
```bash
nvm use && node scripts/validate-vault.mjs
```
Expected: PASS.

- [ ] **Step 2: Makefile sanity**

Run:
```bash
make            # lists targets
make -n bootstrap   # dry-run shows compose up + Floci wait + infra-init/up
```
Expected: target list prints; dry-run resolves variables without executing.

- [ ] **Step 3: Confirm scope — only the intended files changed**

Run:
```bash
git status --porcelain
```
Expected: only `Makefile` (new), `docker-compose.yml` (M), `services/users/users.http` (new), `README.md` (M), `docs/shared/conventions/local-dev.md` (new), `docs/00-overview/index.md` (M), and the spec/plan under `docs/superpowers/`. No service business-logic file, no other `*.http`.

- [ ] **Step 4: End-to-end smoke (best-effort, if Docker is available)**

Run:
```bash
make up && sleep 3 && curl -sf http://localhost:3000/v1/health && echo " <- users health OK"
make down
```
Expected: `{"status":"ok"} <- users health OK`. If Docker isn't available in the environment, note it and rely on Steps 1–3 (the config-level checks) — do not claim the runtime path passed if it wasn't run.

- [ ] **Step 5: Integration handoff**

All changes are on `chore/local-dev-tooling` (off `feature/users-service`). Propose (via the A/B/C/D/E menu) opening one PR — base `feature/users-service` (this branch was cut from it), including a `## References` section (spec, plan, `[[local-dev]]`, `[[git-workflow]]`). Do NOT open or merge unprompted.

Proposed PR title:
```
chore: local dev tooling — Makefile + users .http for REST Client
```

---

## Self-Review

**Spec coverage** (each spec section → task):
- *Makefile both layers + targets* → Task 2 (and the `spike-floci` target constraint).
- *`services/users/users.http` self-contained w/ auth capture* → Task 3.
- *docker-compose publish users port* → Task 1.
- *convention note (Makefile + one-`.http`-per-service + how to run)* → Task 4.
- *README short note* → Task 5.
- *index in MOC* → Task 4 Step 2.
- *validation (make help, curl health, validate-vault, no scope creep)* → Task 6.
- *Write ownership* → per-task **Writer** lines: `docs/` → `obsidian-vault`; root → main session.
- *Non-goals* → Global Constraints (only users `.http`, no `.vscode` envs, spike-floci, no Linear, tooling-only).

No gaps found.

**Placeholder scan:** No TBD/TODO. The `.http` capture field is concrete (`{{register.response.body.$.id}}`) — resolved from the verified `User.id` shape, not left open. All commands have expected output.

**Type/name consistency:** The captured field `register.response.body.$.id` matches the verified `User.id`. The `x-user-id` header is used identically in `/me` and `/patch` (Task 3). The Makefile variable names (`COMPOSE`, `TF`, `TF_LOCAL_DIR`, `FLOCI_URL`) are consistent across all targets. `[[local-dev]]` link name is used identically in Tasks 4 and 5.

## Related

- [[2026-07-03-local-dev-tooling-design]]
- [[ADR-0017-floci-local]]
- [[git-workflow]]
