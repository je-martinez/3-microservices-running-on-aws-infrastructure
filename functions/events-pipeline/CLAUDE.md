# CLAUDE.md — events-pipeline

Nested project memory for the **events-pipeline** (SQS → Lambda). Source of
truth for its stack and conventions. The global `events-pipeline-impl` agent
reads this first, every time. Cross-cutting rules are **referenced**, never
duplicated.

## 1. Stack & versions
- Trigger: SQS message → single Lambda (CQRS dispatch by event `type`).
- Runtime: Node.js (repo-pinned via `.nvmrc` — run `nvm use`).
- Database: DocumentDB (document model + schema).
- Production: AWS Lambda. Local: a worker service via docker-watch.

## 2. Commands
- Install: `nvm use && npm ci`
- Build: `npm run build`
- Test: `npm test`
- Lint: `npm run lint`
- Run local (docker-watch): `docker compose up events-pipeline --watch` (from repo root)

> These commands are the intended contract; the scripts themselves are created
> in the events-pipeline implementation milestone.

## 3. Folder structure
```
functions/events-pipeline/
├── src/handlers/      # type → handler map (e.g. OrderCreatedHandler)
├── src/pipeline/      # lifecycle: STARTED → IN_PROGRESS → COMPLETED/FAILED
├── src/domain/        # Event schema (friendlyId, status_history, audit fields)
├── src/shared/{config,db,di}/
└── tests/
```

## 3b. Local substrate — what Floci does and does not emulate
Probed on 2026-08-03 (Floci v1.5.28). Full evidence and the local-vs-AWS
classification: [../../docs/lessons/floci-sqs-lambda-docdb-support.md](../../docs/lessons/floci-sqs-lambda-docdb-support.md).
**Everything below is a local-only limitation — none of it constrains the
production design.** Do not design around these as if they were AWS limits.

Behaves like real AWS, so rely on it: SQS visibility timeout,
`ApproximateReceiveCount`, automatic DLQ redrive, real batching in the event
source mapping, and **partial batch responses** — returning
`{ batchItemFailures: [{ itemIdentifier: <messageId> }] }` retries **only** the
failed records, verified empirically. Prefer that over throwing, which would
retry the whole batch.

Two constraints when writing code:

- **No multi-document transactions locally.** Floci backs DocumentDB with a
  single standalone `mongo:7.0` (no replica set), so `startTransaction()` fails
  — and it still fails with `retryWrites=false`, so don't chase that flag. Real
  Amazon DocumentDB does support them (engine 4.0+). The designed flow needs
  none: one insert plus single-document `$set`/`$push` updates are atomic in
  MongoDB. **If a handler ever needs a cross-collection atomic write, it will
  work in AWS but cannot be tested locally** — raise it rather than silently
  designing around it.
- **Connect to DocumentDB by container name, never by IP.** `aws docdb
  describe-db-clusters` returns a Docker network IP that Floci reassigns on
  every recreation, and port 27017 is not published to the host. Use the
  backing container name **`floci-docdb-<db-cluster-identifier>`** on
  `3mrai-network`. The connection string belongs in the generated env file
  (see [[env-files]]), never hardcoded. Tests running on the host must enter
  the Docker network to reach it.

## 4. Conventions (referenced, never duplicated)
- CQRS dispatch: [../../docs/shared/patterns/cqrs.md](../../docs/shared/patterns/cqrs.md)
- Dependency injection: [../../docs/shared/patterns/dependency-injection.md](../../docs/shared/patterns/dependency-injection.md)
- Prefixed nano IDs (`friendlyId`): [../../docs/shared/conventions/nano-id.md](../../docs/shared/conventions/nano-id.md)
- Audit fields: [../../docs/shared/conventions/audit-fields.md](../../docs/shared/conventions/audit-fields.md)
- Env validation: [../../docs/shared/decisions/ADR-0014-env-validation-zod.md](../../docs/shared/decisions/ADR-0014-env-validation-zod.md)
- Logging context & tracing: [../../docs/shared/conventions/logging-context.md](../../docs/shared/conventions/logging-context.md)

## 5. Agent rules
- Converse with the user in **Spanish**; write code and comments in **English**.
- `events-pipeline-impl` writes **only source code** — never runs git or Linear.
- Leave finished work in the working tree for the **main session** to commit
  (`github-ops` is an optional helper for complex git batches — see [[git-workflow]]).
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Service spec (vault): [../../docs/domains/events-pipeline/specs/events-pipeline-design.md](../../docs/domains/events-pipeline/specs/events-pipeline-design.md)
- Local substrate probe (SQS/Lambda/DocumentDB on Floci): [../../docs/lessons/floci-sqs-lambda-docdb-support.md](../../docs/lessons/floci-sqs-lambda-docdb-support.md) — see §3b
- Lifecycle: message saved as `STARTED` → `IN_PROGRESS` (to handler) → `COMPLETED`, or `FAILED` (error saved).
- Event fields: `friendlyId`, `order_id`, `user_id`, `type`, `source`, `payload`, `status_history`, audit fields.
