---
title: Local Dev Tooling (Makefile + .http files) — Design
type: spec
area: shared
status: draft
created: 2026-07-03
updated: 2026-07-03
tags: [type/spec, area/shared, status/draft]
related: ["[[ADR-0017-floci-local]]", "[[local-dev-ministack]]", "[[git-workflow]]"]
---

# Local Dev Tooling (Makefile + .http files) — Design

## Summary

Add two developer-experience tools to the repo:

1. A root **`Makefile`** that orchestrates the local dev lifecycle across the two layers
   the repo runs on — the **docker-compose** stack (Floci + services) and the **Terraform**
   config applied against Floci — with self-documenting targets.
2. A convention of **`.http` files per service** (for the VS Code **REST Client** extension,
   `humao.rest-client`) to exercise each service's endpoints locally. We ship the first one
   for **`users`** (the only service with real endpoints today) and document the convention of
   adding one per service as each is built.

This is developer tooling — no service business logic changes. One small **`docker-compose.yml`**
edit is required (publish the `users` port to the host) so the `.http` requests can reach
`localhost`. Done on a single branch (`chore/local-dev-tooling`, off `feature/users-service`),
**no Linear issue** (per the user's request).

## Context / current state

- **docker-compose.yml** defines `floci` (publishes `4566:4566`), `users`, `orders`,
  `tracking`, `events-pipeline`, and a `spike-backend`. The **service ports are commented out** —
  only Floci is reachable from the host today.
- **`users`** already exposes real endpoints (`services/users/src/features/users/http/routes.ts`):
  `GET /v1/health`, `POST /v1/users/register`, `POST /v1/users/login`, `GET /v1/users/me`,
  `PATCH /v1/users/me`, and (behind `E2E_TESTING_ENABLED`) `DELETE /v1/users/e2e-cleanup`.
  It listens on `PORT=3000` inside its container.
- **Terraform local** is not yet a consolidated `local` environment — it exists as two *spikes*
  under `infra/environments/local/`: `spike/` and `spike-floci/`. Only **`spike-floci/`** has the
  Floci-targeted `providers.tf` + `bootstrap.sh` (see [[ADR-0017-floci-local]]). The infra
  `CLAUDE.md` still says "Ministack"; Floci is the current emulator (same `:4566`).
- No `Makefile`, no `.http`/`.rest` files, no `.vscode/` exist yet.

## Goals

- One-command bring-up of the local stack (compose + Terraform-on-Floci) via `make bootstrap`.
- Self-documenting Makefile (`make help` is the default target).
- A committed, self-contained `services/users/users.http` that exercises the users endpoints,
  including the auth flow (login → captured token/identity → authenticated routes).
- A documented convention: **one `.http` per service, added as the service is developed.**
- `users` reachable at `http://localhost:3000` from the host.

## Non-goals (YAGNI)

- **Not** creating `.http` files for `orders` / `tracking` / `events-pipeline` — they have no real
  endpoints yet. Only the **convention** is documented.
- **Not** consolidating the "official" local Terraform environment — that is a separate infra
  milestone. The Makefile targets the current **`spike-floci`** spike, clearly labeled as such.
- **Not** adding `.vscode/settings.json` REST Client *environments* — the `.http` files are
  self-contained with file-level variables + response capture (chosen approach).
- **Not** rewriting `infra/CLAUDE.md`'s Ministack→Floci wording (out of scope; tracked elsewhere).
- **Not** adding CI/test targets beyond what's listed — no `make test`/`make fmt` unless trivially
  free (see open question resolution: excluded for YAGNI).
- **No** Linear issue/milestone.

## Components

### 1. Root `Makefile`

Self-documenting; `help` is the default goal (parses `## ` comments after target names).
All targets `.PHONY`. Variables at the top:

```
COMPOSE      = docker compose
TF_LOCAL_DIR = infra/environments/local/spike-floci
FLOCI_URL    = http://localhost:4566
```

Targets, grouped:

**Compose**
- `up` — `$(COMPOSE) up -d` (Floci + services in background)
- `down` — `$(COMPOSE) down`
- `logs` — `$(COMPOSE) logs -f $(S)` (optional `S=users` to scope to one service)
- `build` — `$(COMPOSE) build`
- `ps` — `$(COMPOSE) ps`

**Infra (Terraform against Floci)** — all use `terraform -chdir=$(TF_LOCAL_DIR)`
- `infra-init` — `init`
- `infra-plan` — `plan`
- `infra-up` — `apply -auto-approve`
- `infra-down` — `destroy -auto-approve`
- `infra-output` — `output` (read Cognito IDs etc.)

**Orchestration**
- `bootstrap` — `up` → wait for Floci healthy (poll `$(FLOCI_URL)` until it answers, bounded
  retries) → `infra-init` → `infra-up`. The "bring everything up" one-shot.
- `clean` — `infra-down` then `down`; optionally clear `./data` (prompted, not silent).

Each target is 1–3 lines; no complex shell logic beyond the bounded Floci-health poll in
`bootstrap` (a short `until curl -sf ... ; do sleep 1 ; done` with a max-attempts guard).

### 2. `services/users/users.http`

Self-contained REST Client file. Structure:

```
@baseUrl = http://localhost:3000

### Health
GET {{baseUrl}}/v1/health

### Register
POST {{baseUrl}}/v1/users/register
Content-Type: application/json

{ "email": "...", "password": "...", ... }

### Login  (captures token for later requests)
# @name login
POST {{baseUrl}}/v1/users/login
Content-Type: application/json

{ "email": "...", "password": "..." }

### Get me  (uses captured identity)
GET {{baseUrl}}/v1/users/me
x-user-id: {{login.response.body.$.<idField>}}

### Update me
PATCH {{baseUrl}}/v1/users/me
...
```

- `###` separators between requests; each has a `### <name>` comment.
- The login request is named (`# @name login`) so later requests reference its captured
  response (`{{login.response.body.$....}}`). The exact field to capture (token vs. user id
  for the `x-user-id` header) is resolved at implementation time by reading
  `services/users/src/features/users/http/routes.ts` and the login command's response shape —
  the plan will name it explicitly.
- Committed to git (`.http` is not gitignored — verified).

### 3. `docker-compose.yml` edit

Publish the `users` service port to the host so `localhost:3000` works:

```yaml
  users:
    ...
    ports:
      - "3000:3000"
```

Minimal, additive. The same pattern (uncomment/add `ports`) applies to `orders`/`tracking`
when they gain endpoints — documented in the convention note, not done now.

### 4. Documentation

- **`docs/shared/conventions/local-dev.md`** (type `convention`, area `shared`; written by the
  **`obsidian-vault`** agent): the Makefile targets (what each does), the **one-`.http`-per-service**
  convention and how to add the next one, and how to run `.http` files with REST Client
  (install `humao.rest-client`, open the file, click "Send Request"). References
  [[ADR-0017-floci-local]], [[local-dev-ministack]], and [[git-workflow]] — does not restate them.
  Indexed from the overview MOC (`docs/00-overview/index.md`).
- **`README.md`** (root): a short "Local development" note (2–3 lines) pointing at `make help`
  and `[[local-dev]]` / the convention note path.

## Write ownership

| Target | Writer |
| --- | --- |
| `Makefile` (new) | main session |
| `services/users/users.http` (new) | main session |
| `docker-compose.yml` (edit: add `users` ports) | main session |
| `README.md` (edit: local-dev note) | main session |
| `docs/shared/conventions/local-dev.md` (new) | `obsidian-vault` |
| `docs/00-overview/index.md` (index the note) | `obsidian-vault` |

No Linear writes. One branch (`chore/local-dev-tooling`), one PR.

## Testing / validation

- `make help` prints the target list (default goal works).
- `make up` brings the stack up; `docker compose ps` shows `users` and `floci` running;
  `curl -sf http://localhost:3000/v1/health` returns `{"status":"ok"}` (proves the published
  port + `.http` baseUrl are correct).
- `make bootstrap` completes: compose up → Floci healthy → `terraform apply` against
  `spike-floci` succeeds (or reports a clear error if the spike isn't apply-ready — noted, not
  fixed here).
- The `users.http` requests run in REST Client: health → register → login (captures token) →
  me (authenticated). At minimum, health + login are demonstrably green.
- `node scripts/validate-vault.mjs` passes (frontmatter + wikilinks for the new convention note).
- Intra-note anchor links (if any) verified by hand — `validate-vault.mjs` does not check them.

## Open questions (resolved)

- **Extra Makefile targets (`test`, `fmt`)?** Excluded for YAGNI; add later if a real need
  appears. `make help` makes discovery easy, so growth is cheap.
- **Which Terraform dir?** `spike-floci` (the Floci-targeted spike with real providers), not
  `spike`. Revisit when a consolidated `local` environment exists.

## Related

- [[ADR-0017-floci-local]]
- [[local-dev-ministack]]
- [[git-workflow]]
