---
title: "Floci Pre-Prod — Handoff and Follow-Ups"
type: plan
area: infra
status: active
created: 2026-10-03
updated: 2026-10-05
tags:
  - type/plan
  - area/infra
  - status/active
propagates-to: none — handoff checklist; the decisions live in the linked spec, ADR-0022, the runbook and the lesson
related:
  - "[[2026-10-02-floci-preprod-environment-design]]"
  - "[[2026-10-02-floci-preprod-environment]]"
  - "[[2026-10-02-dev-stack-floci-2-1]]"
  - "[[preprod]]"
  - "[[environment-exclusivity]]"
  - "[[ADR-0022-preprod-ecs-on-floci]]"
  - "[[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]"
  - "[[2026-10-05-preprod-integrations-design]]"
  - "[[2026-10-05-preprod-integrations]]"
---

# Floci Pre-Prod — Handoff and Follow-Ups

Resume point for the Floci pre-prod milestone. Design: [[2026-10-02-floci-preprod-environment-design]]. Plans: [[2026-10-02-dev-stack-floci-2-1]] (A) and [[2026-10-02-floci-preprod-environment]] (B).

## State at handoff (2026-10-03)

- [PR #117](https://github.com/je-martinez/3-microservices-running-on-aws-infrastructure/pull/117) is MERGED (squash, commit `d7fb466a`) into `feature/floci-preprod-env`. It carried plan A (dev stack on Floci 2.1.0) and plan B (pre-prod). `feat/floci-preprod` was auto-deleted. PR #116 (plan A alone) was closed as superseded.
- Leftover remote branch `build/floci-2-1-dev` (plan A, already contained in `d7fb466a`) can be deleted. Ask the user first.
- Work branch from now on: `feature/floci-preprod-env` (the local checkout is on it).
- Local runtime: dev is UP (bootstrapped 2026-10-03), pre-prod is DOWN (as of 2026-10-03; at the 2026-10-05 audit pre-prod is UP and dev is DOWN).
- Plans A and B are fully executed, reviewed and audited: per-task reviews, final whole-branch reviews, spec-implementation audit and re-audit clean.

## How to resume (do these in order)

1. `git checkout feature/floci-preprod-env && git pull`.
2. `make preprod-down`. Pre-prod must be down first: the exclusivity guard makes `make bootstrap` abort without a TTY while pre-prod runs ([[environment-exclusivity]]).
3. Dev regression on the merged result: `make bootstrap`, `make doctor`, `make test-all`. Classify failures against the known list in "Follow-ups found during validation" below (web-* need `pnpm web:dev` on :4200; `paymentMethodId`; tracking outbox flake). Anything new is a regression to fix on its own branch.
4. Live guard check (dev → pre-prod): with dev up, `make preprod-floci-up < /dev/null` must abort and leave dev untouched.
5. `make ai-sync` to propagate `.claude/skills/{floci,local-env-lifecycle}` to `.ai/` (see [[skill-propagation]]).
6. Propose the milestone PR `feature/floci-preprod-env` → `main` (Phase D). Run the `spec-implementation-audit` skill first; the user reviews and merges.
7. Then the out-of-scope follow-ups below, each on its own branch `<type>/<slug>` off the right base per [[git-workflow]].

Git rules for the next session: the earlier standing authorization ("commit and push without the menu") covered only finishing plans A/B. Every new commit, push or PR goes back to the A/B/C/D/E confirmation menu ([[git-workflow]]); never merge without the user.

## To finish the milestone

- [x] PR #117 merged as `d7fb466a`.
- [ ] Propose the milestone PR `feature/floci-preprod-env` → `main` (Phase D).
- [x] Run `make ai-sync` (see [[skill-propagation]]). Done: `.claude/skills/{floci,local-env-lifecycle}` copied to `.ai/skills/` and synced (lnai sync exports from `.ai/`, it never copies from `.claude/`). `.ai/skills/advance-tracking` differs from its source only in the YAML quoting style of the description (equivalent), left as is.
- [x] Verify live the dev → pre-prod direction of the exclusivity guard ([[environment-exclusivity]]; plan B Task 16 Step 4). Verified: with dev up, `make preprod-floci-up < /dev/null` printed "dev is running; refusing to start preprod without a TTY to confirm" and exited with Error 1; no pre-prod container was created and dev was untouched.
- [x] Live check on dev, 2026-10-03: `make down` followed by `make up` (no `make heal`) left `make doctor` all green (nginx alias attached), and `GET /v1/{users,orders,tracking}/health` through the API Gateway returned 200; authenticated routes returned 401 (the route resolves).
- [x] Run dev `make bootstrap` + `make doctor` + `make test-all` on the merged result. `make bootstrap` OK (2m56s), `make doctor` all checks passed. `make test-all`: unit layer green (Orders 522/522, Users 728/728, events-pipeline 300 + 8 skipped, both Lambda suites, tracking test-db all ok, e2e typecheck ok) except one flaky web spec (see the `rum-sdk.spec.ts` follow-up). E2E: 224 passed, 287 failed, all classified as known: 262 `web-*` (nothing on :4200, `pnpm web:dev` not running) and 25 `paymentMethodId required` (gateway 12, gateway-tracking 10, observability 2, email 1). No new regression.

## Follow-ups found during validation (out of the original scope)

- [ ] Frontend bug captured by RUM in pre-prod: `TypeError` reading `split` of `undefined` in a `time` template of the web app. Owner: web-impl.
- [ ] Web Playwright suite drift: 13 failures in `web-tokyo` against pre-prod. 9 come from a stale selector (`/^add$/i`, broken since commit 22d0497b) and the rest from a `dev-fill` control absent from production builds. Owner: e2e-impl. Not pre-prod defects; they would fail on dev too.
- [ ] Notifications: in 2 of 3 real-browser runs the web app did not send the mark-read `PATCH /v1/notifications/read` (the direct API call works).
- [ ] Gatling full load saturates Floci's single process in pre-prod (86% / 59% OK, p95 17-50 s, 502s from gateway/Cognito); smoke passes. Decide: accept as a local limit, or investigate (awslogs → Floci CloudWatch ingest load is a suspect).
- [ ] Dev E2E: 25 `paymentMethodId required` failures (seen 2026-10-02, reproduced 2026-10-03 with the same count; 23 observed in pre-prod with Stripe on, 2026-10-05). Cause CONFIRMED: `STRIPE_ENABLED=true` sits in the CUSTOM box of `.env.local.orders`, and the E2E fixtures create orders without a `paymentMethodId`. Decision pending: fixtures should send a payment method when Stripe is on, or the suite should force Stripe off. The tracking outbox unit test flakes in full runs (shared local DB) but passes in isolation.
- [ ] Flaky web unit spec `apps/web/src/app/core/observability/rum-sdk.spec.ts` › "registers a callback for every vitals metric": failed once inside `make test-all` (onLCP mock called 0 times, the `vi.mock('web-vitals')` did not apply in that run) and passed 3/3 when the web suite was re-run alone via `pnpm --filter @3mrai/web test`. Pre-existing: the milestone touched only `apps/web/Dockerfile` and `apps/web/nginx.conf`. Because `test-unit` stops at the first failure, a flake here hides every later layer (tracking, e2e typecheck, the whole E2E run). Owner: web-impl.

- [x] `make clean` and `make clean-state` do not guard against a running pre-prod. They run the same `name=^floci-` / `label=floci=true` sweeps and `docker volume rm floci-ecr-registry-data` that `preprod-down` is guarded for ([[environment-exclusivity]] rule 5), so a `make clean` while pre-prod runs deletes pre-prod's containers and its registry volume. Fix on its own branch: `env_guard.py --check-other dev` at the top of both targets. Fixed on `fix/clean-preprod-guard`, verified live 2026-10-03: with pre-prod up, both targets printed "preprod is running; refusing to tear down dev: the sweep would delete preprod's Floci containers and volumes." and exited with Error 1, no container or volume changed and `make preprod-smoke` stayed green; with only dev up, `make clean-state` passed the guard silently and tore dev down as before.
- [x] `infra/scripts/floci_heal.py:93` told the user to run `make heal` even when invoked from `preprod-heal`. Fixed on `fix/preprod-milestone-audit`: the hint is environment-aware.
- [x] Stripe + Geoapify opt-in for pre-prod — designed in [[2026-10-05-preprod-integrations-design]] — plan: [[2026-10-05-preprod-integrations]]. Verified live 2026-10-05 (no key values):
  - Both off: `make preprod-up STRIPE=off GEOAPIFY=off` 3m34s, exit 0, "Stripe: off · Geoapify: off", "no webhook forwarders started", smoke 200s; E2E (gateway, gateway-tracking, email) 95 passed, 11 skipped, 0 failed (baseline).
  - No TTY, no file: "NO: undecided in .env.preprod: STRIPE_ENABLED, GEOAPIFY_ENABLED", make exit 2, skeleton created `-rw-------`, no tfvars written.
  - Both on: `make preprod-up` 3m40s, exit 0, "Stripe: on · Geoapify: on", two forwarding lines, both listeners "Ready!", 3 `users/STRIPE*` + 3 `orders/STRIPE*` secrets, `/geocode/` 200, smoke 200s.
  - E2E with Stripe on: 82 passed, 23 failed, 1 skipped; all 23 are order creation 400 "paymentMethodId field is required" (known fixture follow-up).
  - Browser: order 261005-CWZX74 paid with 4242; `orders.log` `payment_intent.succeeded` [200]; `users.log` `payment_method.attached` [200].
  - Dead listener: killed users listener, `preprod-doctor` "NO: users: stripe listen is not running - make preprod-stripe-listen", exit 2; restart hit 403 (login revoked mid-session), `stripe logout && stripe login`, `--print-secret` equal to the deployed secret, `make preprod-stripe-listen` both "Ready!", doctor exit 0.
  - Geoapify toggle: `GEOAPIFY_ENABLED=false` plus `make preprod-deploy S=web` built and pushed a new `web:<sha>-cfgc5d25e09` (not "already in ECR"), `/geocode/` still 200; plus `make preprod-deploy S=web ENV_ONLY=1` gave 503 `geocoding_disabled`.
- [ ] `preprod_stripe_listen.py start` reports OK right after spawn even if `stripe listen` dies at authentication (seen live with a revoked login). Poll the process after about 2 s.
- [ ] `preprod_stripe_listen.py start` with Stripe off returns before `stop()`, so `make preprod-stripe-listen` leaves old listeners alive.
- [ ] `preprod_stripe_listen.py` `command()` raises a raw `KeyError` when Stripe is on but the AUTO values are missing (after `stop()` already ran). Reuse `pi.current_auto()`.
- [ ] `e2e_env.py` `stripe_env` raises a bare `KeyError` when an AUTO value is missing after a hand-edit.
- [ ] `preprod-up` failing after the second apply never starts the listeners (a re-run is refused as live); `preprod-doctor` catches it.
- [ ] Pre-prod `terraform.tfstate` is mode 644 and now holds real test keys; `chmod 600` it after apply.
- [ ] `stripe_webhook_allowed_cidrs` has no Terraform precondition when `stripe_enabled`.
- [x] `apps/web/nginx.conf` `geocoding_disabled` 503 detail named dev's `.env.local.web`. Fixed on `fix/preprod-milestone-audit`: the detail is environment-neutral.
- [ ] `preprod-floci-up` leaves pre-prod Floci running after an undecided abort.
- [ ] An interrupted prompt (Ctrl-C or EOF) in `preprod_integrations.py` prints a traceback (nothing is written).
- [ ] `docker-compose.yml` `FLOCI_SERVICES_ECS_HOST_VOLUME_ROOTS` uses `${PWD}`, which is stale under `make -C` or another cwd, so the nginx task volume is rejected. Fix: export `PWD := $(CURDIR)` in the Makefile.
- [ ] `check_example_covers()` does not see `.env.preprod` or `.env.preprod.debug`; their `.env.example` blocks are synced by hand.
- [ ] `preprod-heal` has no `env_guard` (with dev up it fails at the `:4566` bind: harmless but unguarded).

Milestone audit 2026-10-05 (4 parallel auditors): doc drift fixed on `fix/preprod-milestone-audit`; no Critical/Important code defects.

## Accepted limits / deferred minors (no action unless they bite)

- A rolling redeploy shows ~1-2 s of 503 (Floci's ALB never health-gates).
- `preprod-deploy ENV_ONLY=1` re-creates the 6 DB-URL secret versions with identical values (Floci RDS drift).
- The exclusivity guard counts only RUNNING containers (an exited stack counts as down).
- `preprod-doctor`'s ECS line trusts `runningCount` (containers are checked indirectly via targets/aliases).
- `preprod_live.py` treats a failing `terraform output` as "from scratch".
- `lambda-bundles` runs without `nvm use` (same as the dev targets).

## Related

- [[2026-10-02-floci-preprod-environment-design]]
- [[2026-10-02-floci-preprod-environment]]
- [[2026-10-02-dev-stack-floci-2-1]]
- [[preprod]]
- [[environment-exclusivity]]
- [[ADR-0022-preprod-ecs-on-floci]]
- [[2026-10-03-floci-preprod-alb-and-ecs-behaviours]]
- [[skill-propagation]]
- [[git-workflow]]
- [[2026-10-05-preprod-integrations-design]]
- [[2026-10-05-preprod-integrations]]
- [[env-files]]
