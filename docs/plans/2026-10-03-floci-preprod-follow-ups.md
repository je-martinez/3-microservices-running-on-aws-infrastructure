---
title: "Floci Pre-Prod — Handoff and Follow-Ups"
type: plan
area: infra
status: active
created: 2026-10-03
updated: 2026-10-03
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
---

# Floci Pre-Prod — Handoff and Follow-Ups

Resume point for the Floci pre-prod milestone. Design: [[2026-10-02-floci-preprod-environment-design]]. Plans: [[2026-10-02-dev-stack-floci-2-1]] (A) and [[2026-10-02-floci-preprod-environment]] (B).

## State at handoff (2026-10-03)

- Branches: `build/floci-2-1-dev` (plan A: dev stack on Floci 2.1.0, 6 commits, base `feature/floci-preprod-env`) and `feat/floci-preprod` (plan B: pre-prod, 30+ commits, built on top of `build/floci-2-1-dev`). Both pushed.
- Stacked PRs: PR A `build/floci-2-1-dev` → `feature/floci-preprod-env`; PR B `feat/floci-preprod` → `build/floci-2-1-dev` (GitHub retargets it to the feature branch when A merges). PR numbers: see GitHub (being opened at handoff).
- Local runtime: pre-prod is UP, dev is DOWN. Return to dev with `make preprod-down && make bootstrap`.
- Plans A and B are fully executed and reviewed: per-task reviews, final whole-branch reviews, spec-implementation audit and re-audit clean.

## To finish the milestone

- [ ] Review and merge PR A, then PR B (the user merges; no auto-merge).
- [ ] Propose the milestone PR `feature/floci-preprod-env` → `main` (Phase D).
- [ ] Run `make ai-sync`: `.claude/skills/floci` and `.claude/skills/local-env-lifecycle` changed and `.ai/skills/` is not yet synced (see [[skill-propagation]]).
- [ ] Verify live the dev → pre-prod direction of the exclusivity guard ([[environment-exclusivity]]; plan B Task 16 Step 4, only unit-tested so far): with dev up, `make preprod-floci-up < /dev/null` must abort.
- [ ] Run dev `make bootstrap` + `make doctor` + `make test-all` on the merged result. Dev was not re-run after the final fix waves touched shared files (collector config, web nginx, `floci_heal`, `env_guard`, Makefile).

## Follow-ups found during validation (out of the original scope)

- [ ] Frontend bug captured by RUM in pre-prod: `TypeError` reading `split` of `undefined` in a `time` template of the web app. Owner: web-impl.
- [ ] Web Playwright suite drift: 13 failures in `web-tokyo` against pre-prod. 9 come from a stale selector (`/^add$/i`, broken since commit 22d0497b) and the rest from a `dev-fill` control absent from production builds. Owner: e2e-impl. Not pre-prod defects; they would fail on dev too.
- [ ] Notifications: in 2 of 3 real-browser runs the web app did not send the mark-read `PATCH /v1/notifications/read` (the direct API call works).
- [ ] Gatling full load saturates Floci's single process in pre-prod (86% / 59% OK, p95 17-50 s, 502s from gateway/Cognito); smoke passes. Decide: accept as a local limit, or investigate (awslogs → Floci CloudWatch ingest load is a suspect).
- [ ] Dev E2E: 25 `paymentMethodId required` failures seen on dev (2026-10-02), likely Stripe enabled in a developer CUSTOM env box vs fixtures. The tracking outbox unit test flakes in full runs (shared local DB) but passes in isolation.

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
