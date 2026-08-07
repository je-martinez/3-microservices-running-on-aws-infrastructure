# Impact Arm B — raw report

## Answers

### Q1. Add a new field to a message in `proto/users.proto`

Affected artifacts:
- `proto/users.proto` — the shared contract itself (edit here first). Note the file's own
  header comment: it is the "source of truth for both the Node server (services/users) and
  the .NET client (services/orders)" and there is **no shared/import mechanism** — Users'
  Dockerfile copies only its own `.proto`, Orders' `.csproj` lists each `.proto` explicitly.
  If the field is added to the `Address` message specifically, the comment explicitly warns
  that `tracking.v1.Address` (referenced in `services/tracking/...` design, not literally
  found as a second `.proto` file in this repo — see caveat below) mirrors it "field for
  field... by hand" and must be updated in parallel, since the two are deliberately NOT
  sharing via import.
- **services/users** (the gRPC server / message producer):
  - Regenerate/hand-update the Node-side generated types bound to this `.proto` (the repo
    uses a generated client under `src/generated/prisma/` for Prisma, but the gRPC message
    types come from `.proto` codegen referenced from `shared/grpc/server.ts` — this file was
    not directly opened, so the exact codegen command/output path is not verified firsthand).
  - `services/users/src/features/users/grpc/` (per the folder-structure listing in its
    CLAUDE.md) — the handler that populates `UserResponse`/`Address` must set the new field.
  - If the field maps from the Postgres `address Json?` column (per the proto's own comment
    describing how `Address` is populated), the Prisma schema / mapping code in
    `services/users/src/shared/db/` may need updating too, depending on whether the new field
    is sourced from existing data or a new column.
- **services/orders** (the gRPC client / consumer):
  - The `.csproj` proto reference (comment says "Orders' csproj lists each .proto explicitly")
    — regeneration of the C# gRPC client stubs.
  - Any code consuming `ICurrentCaller`/the gRPC client response that reads `UserResponse`
    fields (services/tracking/CLAUDE.md §6 mentions Orders' `ICurrentCaller` uses "the same
    shape" gRPC pattern as Tracking, implying Orders is a consumer of this same call).
  - **Not verified firsthand**: I did not open Orders' actual `.csproj` or C# gRPC client code
    to confirm the exact file(s) — this is inferred from `proto/users.proto`'s own header
    comment and `services/tracking/CLAUDE.md`'s cross-reference to Orders using the same
    pattern.
- **services/tracking** (also a gRPC client of `users.v1.Users/GetUserById`, confirmed in its
  CLAUDE.md §6): its outbound gRPC client under `services/tracking/src/shared/grpc/` would need
  updated generated stubs if the client deserializes the new field, though if it only reads
  existing fields, no logic change is required — only regenerated types.
- If the new field is PII-adjacent: the proto's own comment says `UserResponse` is "guarded by
  the x-api-key interceptor" and must **never be logged** — a new field must not leak into logs,
  per [[logging-context]] rules referenced repo-wide.
- Documentation: `docs/domains/users/specs/users-service-design.md` (not opened directly, but
  is the canonical spec per `services/users/CLAUDE.md` §6 "Design reference") likely documents
  the gRPC message shape and would need updating per the repo's doc-propagation rule (root
  CLAUDE.md "Documentation propagation" section) — not confirmed by directly reading that spec.

**Confidence: medium.** High confidence on the two confirmed consumers (services/users as
server, services/tracking as confirmed client via its CLAUDE.md) and on the "no shared import,
hand-sync `Address`" rule (directly stated in the proto file itself). Medium/lower confidence on
Orders, because I inferred its involvement from a comment in `proto/users.proto` and a
cross-reference in Tracking's CLAUDE.md, but never opened any file under `services/orders/`
directly, so I cannot name Orders' exact C# file paths. Did not check for a build/codegen script
(e.g., a Makefile target that regenerates gRPC stubs for both languages) which likely exists and
is itself an artifact that "must change" only in the sense of being *run*, not edited — did not
verify if such a script exists.

### Q2. Add a new HTTP endpoint to the Users service — all required steps/artifacts before "done"

From `services/users/CLAUDE.md` (primary source) and `docs/shared/conventions/testing.md`:

1. **Route + schema code**: add the route under `services/users/src/features/users/http/routes.ts`,
   with a Zod schema in `services/users/src/features/users/http/schemas.ts`. Request/response
   models must be **named components** registered via `z.globalRegistry.add(schema, { id })`
   (§2a), not inline anonymous schemas — otherwise Apidog/openapi.yaml shows them badly and the
   generator prunes unreferenced ("orphan") schemas.
2. **Regenerate `openapi.yaml`**: `nvm use && pnpm generate:openapi`, and commit the regenerated
   file together with the code change. This is called a "GOLDEN RULE" — a route change without
   a matching `openapi.yaml` update is explicitly called an "incomplete change" (§2a).
3. **Verify**: every route's body/params/response resolves to a named `$ref`, and
   `pnpm build && pnpm lint && pnpm test` pass (§2a).
4. **Three test layers** (§2b, and repo-wide rule in root CLAUDE.md "Testing" section +
   `docs/shared/conventions/testing.md`):
   - Unit/integration — vitest via `buildApp` with a mocked Awilix container.
   - Internal E2E — hits the service directly (`e2e/`, `localhost:3000`) with a faked
     `x-user-id`.
   - **Gateway E2E** — through `API_GATEWAY_URL` with a **real Cognito JWT**, spec under
     `e2e/tests/gateway/`, run via `pnpm --filter @3mrai/e2e test` (needs `make bootstrap`).
     `testing.md` states a missing gateway spec is an "incomplete change" and cites concrete
     precedent bugs this layer caught that the other two missed (404 from an unregistered
     gateway route, a dropped path param, a method mismatch) — three real bugs in one session,
     per that file.
5. **Gateway routing** (infrastructure): confirmed by reading `infra/modules/compute/nginx/nginx.conf`
   — Users is the nginx catch-all backend (`location / { set $backend users; proxy_pass
   http://$backend:3000; }`), so a new `/v1/...` Users route generally does NOT need a new
   nginx `location` block (unlike Orders/Tracking, which have explicit `location` blocks).
   However, I did not verify whether `infra/modules/api-gateway/*.tf` (which does reference
   "users" per a grep hit on `main.tf`/`variables.tf`) needs a matching entry — e.g. for the
   JWT authorizer's route allowlist or API Gateway route table. I did not open those `.tf`
   files, so this is a **gap**, not a verified "no change needed."
6. **Error contract**: if the endpoint introduces a new failure mode, it should be a typed auth
   error in `shared/auth/auth-errors.ts` mapped by the global `setErrorHandler` (per the design
   reference section, §6, listing existing endpoints' error shapes as precedent, e.g. `409
   email_exists`).
7. **Events**: only if the endpoint's action should notify other services — e.g. registration
   publishes `USER_CREATED` to SQS via `shared/messaging/event-publisher.ts`, consumed by
   events-pipeline. Not every endpoint needs this; it's conditional on whether the action is a
   domain event other services care about.
8. **Documentation propagation**: per root CLAUDE.md, "before proposing the PR that closes an
   issue," propagate decisions into `docs/domains/users/specs/users-service-design.md` (the
   design reference named in `services/users/CLAUDE.md` §6) — update the endpoint list there,
   route through the `obsidian-vault` agent (I did not open this spec file directly to confirm
   its exact current endpoint-listing format).
9. **Git flow** (process, not code): per root CLAUDE.md, task branch → implement → commit →
   PR task→feature branch via the confirmation menu — not a file artifact but a required step
   before the change counts as "done" in this repo's workflow.

**Confidence: high** for steps 1–4 (directly and explicitly stated as required in
`services/users/CLAUDE.md` and `docs/shared/conventions/testing.md`, both read in full).
**Medium** for step 5 (nginx confirmed via direct read; api-gateway Terraform module not opened,
so I can't confirm whether it needs a per-route change or is generic/wildcard like nginx).
**Medium** for steps 6–8, which are conditional/precedent-based rather than an explicit
numbered checklist for "adding an endpoint" specifically.

### Q3. Rename a value in the Tracking service's delivery-status enum

Definition: `services/tracking/src/features/tracking/domain/status.py` — `TrackingStatus`
(`StrEnum`) with five members: `PLACED, PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED`. This
is described as a StrEnum specifically so it "serializes as its own name — matching both the
`VARCHAR(50)` storage and the REST surface." A rename changes the wire string, not just an
internal symbol.

Confirmed affected artifacts (grepped `OUT_FOR_DELIVERY` as a representative member across the
whole repo, 89 hits across many files; grouping by artifact):

**Inside Tracking service (in-service consumers):**
- `services/tracking/src/features/tracking/domain/status.py` — the enum itself, `STATUS_ORDER`
  tuple, `parse_status()` error message.
- `services/tracking/src/features/tracking/domain/models.py` — references the status set in a
  docstring/type comment.
- `services/tracking/src/features/tracking/commands/test_mode_progression.py` — TestMode
  progression schedule.
- Database column `tracking.status` and `tracking_history.status`, both `VARCHAR(50)` — per
  `docs/domains/tracking/specs/tracking-service-design.md` (enum values listed explicitly in
  the schema tables). A rename of a stored value would need either a migration to rewrite
  existing rows or a mapping shim — I did not find an Alembic migration file confirming how a
  rename would be handled; this is a **gap**.
- A large number of test files under `services/tracking/tests/` (test_rest_carrier_status.py,
  test_repository.py, test_status_state_machine.py, test_status_changed_emission.py,
  test_test_mode_progression.py, test_rest_init_tracking.py, test_sqs_event_publisher.py).

**Outside Tracking (cross-service consumers — this is the part the question specifically asks
for):**
- **events-pipeline** (`functions/events-pipeline/`):
  - `src/handlers/tracking-status-changed.ts` — Zod schema
    `z.enum(["PLACED","PROCESSING","SHIPPED","OUT_FOR_DELIVERY","DELIVERED"])` validating the
    inbound SQS envelope's `status` field, and a status→email-template-id map.
  - `src/email/catalog.ts` — email catalog referencing the status for template selection.
  - `emails/tracking-status-changed.tsx` — the react-email template itself has a TypeScript
    union type over the five literal strings and a per-status content map (confirmed: line 6
    and line 27 of that file matched the grep).
  - `tests/handlers/tracking-status-changed.test.ts` — tests asserting transitions and status
    values.
  - Per `services/tracking/CLAUDE.md` §5d: Tracking publishes `TRACKING_STATUS_CHANGED` to SQS
    on every transition, consumed by events-pipeline, which emails the user — this is the
    delivery mechanism that carries the enum's string value across the service boundary.
- **Realtime WebSocket push** (per `services/tracking/CLAUDE.md` §5d and
  `docs/lessons/floci-websocket-apigw-dynamodb-support.md`, grep-matched): the same
  `TRACKING_STATUS_CHANGED` event also drives a realtime WebSocket push (DynamoDB-indexed by
  `cognito_sub`) — the status string travels through this path too, though I did not open the
  WebSocket push handler's source file directly to name it (inferred from the lesson doc's
  content and the CLAUDE.md cross-reference); this is a **gap**.
- **e2e test suite** (`e2e/`, repo-root level, cross-service):
  - `e2e/tests/tracking.spec.ts`
  - `e2e/tests/gateway/tracking-flow.spec.ts`
  - `e2e/tests/gateway/realtime-tracking.spec.ts`
  All three hardcode the status string, confirmed via grep.
- **No frontend exists in this repo** — I explicitly searched for a frontend/web/client
  directory at depth 2 and found none, so there is no UI status-label/badge consumer to update
  (ruling this out, not a gap).
- **Orders service**: I grepped `services/orders/*.cs` for `TrackingStatus`/`delivery.status`/
  `tracking.status` and got **zero matches** — Orders does not appear to consume the Tracking
  status enum directly. This is reasonably confident since it was a direct repo-wide grep with
  no hits, though Orders could reference tracking status indirectly through a shape I didn't
  grep for (e.g., a differently-named field after gRPC/JSON mapping).
- **Documentation** (must update for the rename to be "done" per the propagation rule, though
  not code): `docs/domains/tracking/specs/tracking-service-design.md` (schema tables, status
  descriptions, sequence diagram), `docs/domains/tracking/decisions/testmode-in-process-asyncio-task.md`,
  `docs/shared/conventions/testing.md` (assertion sets for gateway E2E tests),
  `docs/lessons/floci-websocket-apigw-dynamodb-support.md`, `docs/domains/events-pipeline/specs/events-pipeline-design.md`
  — all grep-matched with the literal enum value.

**Confidence: medium-high.** High confidence on the enum definition, in-service consumers, and
the events-pipeline email-template consumer chain — all confirmed by direct file reads or
unambiguous grep hits with surrounding context read. Medium confidence on the WebSocket
push handler specifically (identified its existence and the mechanism via CLAUDE.md/docs, but
did not open the actual handler source to name the exact file). Medium confidence that Orders
truly has zero exposure — the grep was narrowly scoped to three literal patterns and could miss
an indirectly-named field. Did not check for a possible shared TypeScript/Python type-generation
step (e.g., if event-pipeline's Zod enum is meant to be kept in sync with Tracking's Python enum
by a script rather than by hand) — no such script was found, but I did not exhaustively search
for one.

## Files read

1. `CLAUDE.md` (root)
2. `proto/users.proto`
3. `services/users/CLAUDE.md`
4. `services/tracking/CLAUDE.md`
5. `functions/events-pipeline/CLAUDE.md`
6. `services/tracking/src/features/tracking/domain/status.py`
7. `docs/shared/conventions/testing.md` (partial — grepped with context, not full read)
8. `docs/shared/conventions/versioning.md` (full read)
9. `infra/modules/compute/nginx/nginx.conf` (partial — grepped with context)

Files inspected only via grep match-line output (not opened/read as full files), listed because
their content directly informed answers above:
- `docs/domains/tracking/specs/tracking-service-design.md`
- `docs/domains/events-pipeline/specs/events-pipeline-design.md`
- `docs/lessons/floci-websocket-apigw-dynamodb-support.md`
- `functions/events-pipeline/emails/tracking-status-changed.tsx`
- `functions/events-pipeline/src/handlers/tracking-status-changed.ts`
- `functions/events-pipeline/src/email/catalog.ts`
- `functions/events-pipeline/tests/handlers/tracking-status-changed.test.ts`
- `e2e/tests/tracking.spec.ts`
- `e2e/tests/gateway/tracking-flow.spec.ts`
- `e2e/tests/gateway/realtime-tracking.spec.ts`
- various `services/tracking/tests/*.py` files
- `docs/superpowers/plans/2026-08-03-events-pipeline-milestone.md`
- `docs/superpowers/specs/2026-08-03-events-pipeline-milestone-design.md`
- `docs/superpowers/plans/2026-08-05-realtime-tracking-events-websocket.md`
- `docs/superpowers/specs/2026-08-05-realtime-tracking-events-websocket-design.md`
- `docs/domains/tracking/decisions/testmode-in-process-asyncio-task.md`

## Answer sources

| Question # | File(s) that answered it | Position |
|---|---|---|
| 1 | `proto/users.proto` (primary); `services/tracking/CLAUDE.md` §6 (Orders/Tracking gRPC client confirmation) | proto read 2nd; tracking CLAUDE.md read 4th |
| 2 | `services/users/CLAUDE.md` §2a, §2b (primary); `infra/modules/compute/nginx/nginx.conf` (gateway routing check) | users CLAUDE.md read 3rd; nginx.conf read 9th |
| 3 | `services/tracking/src/features/tracking/domain/status.py` (definition); repo-wide grep of `OUT_FOR_DELIVERY` (cross-service consumers); `services/tracking/CLAUDE.md` §5d (event mechanism) | status.py read 6th; grep run before file #6 (interleaved); tracking CLAUDE.md read 4th |

## Confidence

| Question # | Confidence | What might be missing |
|---|---|---|
| 1 | Medium | Orders' exact `.csproj`/C# file paths never opened directly (inferred from proto comment + Tracking's CLAUDE.md cross-reference); did not check for a shared codegen/build script that regenerates both language stubs; did not open `docs/domains/users/specs/users-service-design.md` to confirm doc-propagation target |
| 2 | High for code/test steps; Medium for infra | `infra/modules/api-gateway/*.tf` not opened despite a grep hit on "users" in `main.tf`/`variables.tf` — unclear if a new Users route needs a Terraform change beyond nginx |
| 3 | Medium-High | WebSocket push handler source file not opened directly (existence/mechanism inferred from CLAUDE.md + lesson doc); Orders' zero-exposure conclusion rests on a narrowly-scoped grep, not a full read of the Orders codebase; no check for a type-sync script between Tracking's Python enum and events-pipeline's Zod enum |

## Index gaps

| Question # | Fully / partially / not answered by index | Where fell back to source |
|---|---|---|
| 1 | Partially — index (`proto/users.proto` + `services/tracking/CLAUDE.md`) named the two confirmed services and the hand-sync rule, but had no per-service CLAUDE.md for Orders' gRPC client details, and no explicit "what to change" checklist for a proto field addition | Fell back to reading the raw `.proto` file's own comments as the closest thing to an index entry; did not locate and read actual Orders C# source since no `services/orders/CLAUDE.md` reference was given in this task and grep for it wasn't run in Q1 specifically (only Q3) |
| 2 | Fully for application-layer steps — `services/users/CLAUDE.md` §§2a/2b is an explicit, numbered checklist ("GOLDEN RULE") covering openapi regen and 3-layer testing | Fell back to source (`infra/modules/compute/nginx/nginx.conf`) to verify the infra/gateway-routing angle, since no CLAUDE.md file discusses per-route Terraform/API-Gateway changes explicitly |
| 3 | Not answered by index for cross-service impact — no CLAUDE.md or spec gives a "if you rename a tracking status, update X, Y, Z" checklist; `services/tracking/CLAUDE.md` §5d explains the event *mechanism* (why events-pipeline and the WebSocket push are downstream) but not a change-impact list | Fell back entirely to a repo-wide grep for the literal enum value `OUT_FOR_DELIVERY` to enumerate concrete consumer files, since the index only explains architecture, not blast radius |

## Total distinct files read

9
