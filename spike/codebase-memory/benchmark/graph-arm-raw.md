# Graph-assisted change-impact assessment (A4 arm)

## Answers

### Q1 — Add a new field to a message in `proto/users.proto`

`proto/users.proto` (repo root) defines `users.v1.Users/GetUserById` and its
`UserResponse`/`Address` messages. It is the **shared source contract for two
independently-generated clients**, no shared codegen package — each side
regenerates from the same file on its own:

- **`services/users`** (Node/Fastify, the gRPC *server*):
  - Server handler `services/users/src/features/users/grpc/get-user-by-id.ts`
    builds the response — a new field must be populated here.
  - `services/users/src/shared/grpc/server.ts` wires the generated server stub.
  - Whatever generates the TS stubs from `proto/users.proto` for this service
    (not directly inspected — see Graph gaps) must be re-run.
  - If the new field is PII (like `Address` today), the file's own comment
    block says the x-api-key interceptor on this gRPC surface already governs
    it, and it must never be logged in plaintext, per [[logging-context]].

- **`services/orders`** (.NET, a gRPC *client*):
  - `Orders.Infrastructure.csproj` references `proto/users.proto` directly
    (`GrpcServices="Both"`) and regenerates C# stubs at build time
    (`dotnet build`/`dotnet restore`).
  - `services/orders/src/Orders.Infrastructure/Grpc/UserDirectoryGrpcClient.cs`
    maps the wire response onto `CallerProfile`/`CallerAddress` — a new field
    needs a mapping line here (see `ToAddress`, lines 55-68, and the
    `Id`/`Email` mapping at line 30) or it is silently dropped.
  - `services/orders/src/Orders.Application/Identity/CallerProfile.cs` (the
    port-side DTO) needs the new field added to actually flow past the
    Infrastructure boundary (Application must not reference the generated
    gRPC types directly — Clean Architecture rule in `services/orders/CLAUDE.md` §3).
  - Consumers: `CreateOrderService.cs` (uses the profile for `ORDER_CREATED`
    author/email), `Orders.Api/Identity/CurrentCaller.cs`.
  - Tests to update: `UserDirectoryGrpcClientTests.cs` ("Maps the email off the
    wire onto the caller profile"), `CreateOrderServiceTests.cs`,
    `OrdersApiFactory.cs` (test factory), `ReadsNoGrpcTests.cs`.

- **`services/tracking`** (Python, a gRPC *client*):
  - `services/tracking/scripts/generate_grpc_stubs.py` regenerates
    `services/tracking/src/shared/grpc/generated/users_pb2.py` +
    `users_pb2_grpc.py` from `proto/users.proto` — must be re-run.
  - `services/tracking/src/shared/grpc/users_client.py` is the wrapper that
    calls `GetUserById` and would need to read the new field.
  - `services/tracking/tests/test_grpc_stubs.py` and `tests/conftest.py`
    reference `GetUserById` and would need updating if the new field affects
    fixtures/mocks.
  - Tracking's own CLAUDE.md confirms this is its only gRPC surface (outbound
    only, no gRPC served) — see §6.

- **Documentation**: `docs/shared/decisions/ADR-0003-grpc-inter-service.md` and
  `docs/domains/orders/decisions/grpc-api-key-authorization.md` describe this
  contract and may need updating per [[doc-propagation]] if the field changes
  the contract's shape meaningfully (not just an internal implementation
  detail).

- **Not affected**: `functions/events-pipeline` — it does not call the Users
  gRPC surface directly (Tracking does, on its behalf, and forwards only the
  resolved email in the envelope).

**Important asymmetry already documented in the proto file itself**:
`tracking.v1.Address` (used for a different purpose, not the Users gRPC
surface — see Graph gaps, unconfirmed second proto) is deliberately **hand
mirrored** field-for-field from `users.v1.Address` rather than imported,
specifically so each service's codegen only loads one proto file. If the new
field is added to `Address`, the comment at `proto/users.proto:20-25` says the
mirrored copy must be updated **by hand** — grep/graph will not catch this
because there's no import edge to follow.

### Q2 — Add a new HTTP endpoint to the Users service: full required steps

Per `services/users/CLAUDE.md` (source of truth, §2a/§2b/§6), a route is not
done until:

1. **Implement the route** — `src/features/users/http/routes.ts` (Fastify)
   with a Zod `schema` (body/querystring/params/response) in
   `src/features/users/http/schemas.ts`. New request/response models must be
   **named components** registered via `z.globalRegistry.add(schema, { id })`
   (not inline anonymous schemas), or Apidog won't show them as proper models.
2. **Regenerate the OpenAPI spec**: `nvm use && pnpm generate:openapi`,
   committing the regenerated `services/users/openapi.yaml`. This is the
   artifact imported into Apidog — an endpoint without this is an incomplete
   change per the GOLDEN RULE in §2a.
3. **Three test layers**, per §2b / [[testing]]:
   - Unit/integration — vitest via `buildApp` with a mocked Awilix container.
   - Internal E2E — hits the service directly (`e2e/`, localhost:3000),
     `x-user-id` faked. `e2e/tests/users.spec.ts` and `e2e/tests/otp.spec.ts`
     exist for the current endpoints and are the pattern to follow.
   - **Gateway E2E** — through `API_GATEWAY_URL` with a **real Cognito JWT**
     (`e2e/tests/gateway/`, `pnpm --filter @3mrai/e2e test`, needs `make
     bootstrap`). Explicitly called out as non-optional: internal/unit tests
     fake the authorizer and cannot catch gateway-only bugs (missing route,
     dropped path param, method mismatch).
4. **DI wiring** if the route needs a new use-case/dependency — Awilix,
   PROXY injection, SINGLETON infra / SCOPED use-cases ([[dependency-injection]]).
5. **Logging & tracing** — no ad hoc logging; enrich via the existing
   AsyncLocalStorage log-context pattern (`shared/logging/log-context.ts`,
   `setLogContext`), respecting the repo-wide rules: shared context fields,
   no plaintext PII (masked email or `email_hash`), `app_event` naming for
   flow events, OTel config via env vars only.
6. **Error handling** — typed errors added to `shared/auth/auth-errors.ts` (or
   feature-local equivalent) mapped by the global `setErrorHandler`.
7. **Convention compliance** — API versioning (`/v1` prefix), nano-ID
   conventions if creating a resource, soft-delete-only if deleting, audit
   fields, DB naming (snake_case columns ↔ PascalCase properties via Prisma).
8. **Vault propagation** (repo-wide CLAUDE.md, "Documentation propagation"):
   if the endpoint reflects a design decision from a spec/plan, the vault
   service spec `docs/domains/users/specs/users-service-design.md` needs its
   endpoint list/behavior updated and bidirectionally linked, via
   `obsidian-vault` (sole writer of `docs/`).
9. **Git flow** (repo-wide CLAUDE.md): task branch off the feature branch,
   commit, PR task→feature via the A/B/C/D/E confirmation menu — never
   auto-committed.

This list comes directly from `services/users/CLAUDE.md` — a "golden rule"
document already engineered for exactly this question — rather than from
graph traversal, which cannot express "what must exist" (process/artifact
requirements), only "what calls what."

### Q3 — Rename a value in Tracking's delivery-status enum

The enum is `TrackingStatus` (Python `StrEnum`) in
`services/tracking/src/features/tracking/domain/status.py:19-31`: `PLACED`,
`PROCESSING`, `SHIPPED`, `OUT_FOR_DELIVERY`, `DELIVERED`. Critically, **this
is NOT proto-generated** — Tracking serves no gRPC (confirmed by
`services/tracking/CLAUDE.md` §6: "Tracking is REST-only... the single gRPC in
this service is an OUTBOUND client to Users"). The five-value contract is
enforced only by convention/tests, not by a shared IDL, so a rename has no
compiler/codegen to catch every site — all of the following are **string
literal** matches that must be updated by hand:

**Inside Tracking service:**
- `domain/status.py` — the enum itself; also `STATUS_ORDER` tuple,
  `INITIAL_STATUS`, `TERMINAL_STATUS` derive from it automatically (no extra
  edit needed there, they reference the enum member).
- `commands/update_status.py` — the transition command.
- `commands/test_mode_progression.py`, `commands/create_tracking.py` — use
  `TrackingStatus.PLACED` (the initial value) directly.
- `api/schemas.py`, `api/init_tracking_router.py` — the REST wire schema/serialization.
- `domain/models.py` — the DB-persisted model (`VARCHAR(50)` column storing
  the enum's string value verbatim — **existing rows in the DB carry the old
  string** and would need a migration/backfill, not just a code rename).
- `shared/messaging/sqs_event_publisher.py` — publishes `TRACKING_STATUS_CHANGED`
  events carrying the status string in the envelope payload.
- `shared/audit/audit_actor.py` — referenced in the same grep hit set (verify
  if it holds a status literal or just an unrelated actor constant — not
  individually confirmed).
- Tests: `tests/test_status_state_machine.py`, `tests/test_rest_carrier_status.py`,
  `tests/test_status_changed_emission.py`.

**Outside Tracking — consumers of the string contract:**
- **`functions/events-pipeline`** (the biggest blast radius outside Tracking
  itself):
  - `src/handlers/tracking-status-changed.ts` — hardcodes the Zod enum
    `z.enum(["PLACED","PROCESSING","SHIPPED","OUT_FOR_DELIVERY","DELIVERED"])`
    (line 25) that validates the incoming SQS payload — an unrecognized value
    is a **PermanentError** (never retried), so a rename desynced between
    Tracking and this file causes silent, permanent event loss. Also hardcodes
    the `TEMPLATE_BY_STATUS` map (lines 35-41) from status → email-template key.
  - `emails/tracking-status-changed.tsx` — its own separate TS union type
    (`"PLACED" | "PROCESSING" | ... | "DELIVERED"`, line 6) and a `COPY` map
    keyed by every status (lines 14-35) with human-readable heading/body text
    per status.
  - `src/email/catalog.ts` — defines 5 named templates
    (`tracking-status-changed-placed`, `...-processing`, `...-shipped`,
    `...-out-for-delivery`, `...-delivered`) each with `sampleProps` using the
    literal status strings — **the template keys themselves are also
    status-derived slugs** (kebab-cased), so a rename may require renaming the
    catalog keys too, not just the string values inside them.
  - `tests/handlers/tracking-status-changed.test.ts`.
- **`e2e/tests/tracking.spec.ts`** — internal E2E, extensive literal assertions:
  a `TRACKING_STATUSES` array (lines 51-56), `expect(tracking.status).toBe("PLACED")`
  and similar for every status, transition-guard tests asserting specific
  rejected/accepted statuses (`carrierPut(api, orderId, "PROCESSING")` etc.),
  and an error-message assertion (`expect(body.detail).toContain("PLACED")`)
  — the last one means the rename must also match whatever string
  `parse_status`'s `ValueError` message embeds (it interpolates
  `TrackingStatus` values directly, `status.py:184-190`).
- **`e2e/tests/gateway/tracking-flow.spec.ts`** — gateway E2E: same
  `TRACKING_STATUSES`-style array (lines 52-56), status assertions through the
  full journey, AND an assertion on the **rendered email subject text**
  (line 294, checking for the word "delivered" lowercased — derived from
  `status.replace(/_/g, " ").toLowerCase()` in the handler) — a rename changes
  this text too.
- **`e2e/tests/gateway/realtime-tracking.spec.ts`** — asserts the realtime
  WebSocket push payload's `status` field across a sorted list of the four
  non-PLACED statuses (line 97).

**Not affected:**
- `proto/users.proto` and Users/Orders gRPC — Tracking status has no proto
  representation; the only proto in this repo pair is the Users identity
  contract, unrelated to delivery status.
- Orders service — Orders reads Tracking data through Tracking's own REST
  batch-read API and a typed `TrackingDto` (per `services/orders/CLAUDE.md`
  §6), not confirmed to embed the status enum's literal values in Orders code
  (not found in any grep/graph hit — see Graph gaps, unconfirmed).

## Queries run

1. `MATCH (f:File) WHERE f.file_path CONTAINS 'proto' RETURN f.file_path LIMIT 50`
   → 1 row (`proto/users.proto`).
2. `MATCH (f:File) WHERE f.file_path CONTAINS '.pb.' OR f.file_path CONTAINS '_pb2' OR f.file_path CONTAINS 'grpc' OR f.file_path CONTAINS 'protoc' RETURN f.file_path LIMIT 100`
   → 16 rows (Tracking generated stubs + client, Users gRPC server/handler/tests, two ADR docs).
3. `MATCH (c)-[:CALLS]->(f:Function) WHERE f.name = 'GetUserById' OR f.name = 'get_user_by_id' RETURN c.name, c.file_path`
   → 0 rows (method-name mismatch; `GetUserById` is a gRPC-client **Method**, not a plain `Function` — see Graph gaps).
4. `MATCH (m:Method) WHERE m.name CONTAINS 'GetUserById' RETURN m.name, m.file_path`
   → 4 rows (Tracking generated grpc stub x2, Orders test, Tracking conftest).
5. `MATCH (c)-[:CALLS]->(m:Method) WHERE m.file_path CONTAINS 'UserDirectoryGrpcClient' RETURN c.name, c.file_path`
   → 21 rows — surfaced `CreateOrderService.CreateAsync`, `CurrentCaller.ResolveInternalUserIdAsync`,
   and the full `UserDirectoryGrpcClientTests`/`ReadsNoGrpcTests` test suites as callers.
6. `MATCH (f:File) WHERE f.file_path CONTAINS 'tracking' AND (f.file_path CONTAINS 'status' OR f.file_path CONTAINS 'enum') RETURN f.file_path LIMIT 50`
   → 8 rows: `domain/status.py`, `commands/update_status.py`, 3 Tracking test files, and — critically —
   the 3 events-pipeline files (`tracking-status-changed.ts` handler+test, `.tsx` email template).
7. `MATCH (c)-[:IMPORTS]->(m:Module) WHERE m.file_path CONTAINS 'domain/status' RETURN c.file_path`
   → 0 rows (see Graph gaps — Python cross-module `IMPORTS` edges did not resolve for this module;
   fell back to `grep` which found the two real importers).
8. `MATCH (f:File) WHERE f.file_path CONTAINS 'events-pipeline' AND (f.file_path CONTAINS 'tracking' OR f.file_path CONTAINS 'status') RETURN f.file_path LIMIT 50`
   → 3 rows, confirming query 6's events-pipeline hits (handler, test, email template) and no others.

Total: 8 Cypher queries.

## Files read

- `proto/users.proto` — full contents needed (message fields, the load-bearing
  comment about `Address` being hand-mirrored rather than imported); the graph
  has no node type for "message field," only files/functions/classes.
- `services/orders/src/Orders.Infrastructure/Grpc/UserDirectoryGrpcClient.cs` —
  to confirm the exact mapping code (which fields are actually read off the
  wire response today) and the `ToAddress`/null-handling logic, since the
  graph's `CALLS` edges show *that* it's called but not *what fields it reads*.
- `services/users/src/features/users/grpc/get-user-by-id.ts` — same reason;
  confirms the server-side handler shape (very thin — just calls the query
  service) so the "populate the new field" step in Q1 is accurately located.
- `services/tracking/src/features/tracking/domain/status.py` — full file;
  needed the actual enum values and, importantly, the guard-logic comments
  (`parse_status`'s error message embeds status values — relevant to Q3's
  "what strings does a rename touch" scope) which a graph node/property
  cannot represent.
- `functions/events-pipeline/src/handlers/tracking-status-changed.ts` — full
  file; needed to see the hardcoded Zod enum and `TEMPLATE_BY_STATUS` map,
  i.e. literal string duplication the graph can't see (it only indexes
  code structure, not string literal contents/values).
- `functions/events-pipeline/emails/tracking-status-changed.tsx` (partial,
  first 50 lines) — same reason: the TS union type and `COPY` map keyed by
  status.
- Both service CLAUDE.md files (`services/orders/CLAUDE.md`,
  `services/users/CLAUDE.md`, `services/tracking/CLAUDE.md`,
  `functions/events-pipeline/CLAUDE.md`) were supplied automatically by the
  harness as system-reminders when I read files inside those directories —
  not fetched via a tool call, but they were the primary source for Q2's
  answer (a graph of function calls cannot express "you must regenerate
  openapi.yaml" or "you must run the gateway E2E suite," which are
  process/artifact requirements, not code dependencies).

Grep (not the graph) was used twice, both as a directed fallback after a graph
query returned 0 or was structurally unable to answer:
- `grep -rn ... functions/events-pipeline/emails/tracking-status-changed.tsx`
  to check status literals after finding the file via the graph.
- `grep -rln "PLACED\|OUT_FOR_DELIVERY\|tracking-status-changed" ...` across
  the repo to catch any consumer the graph's Python `IMPORTS` edges missed
  (query 7 above returned empty) and to check the e2e test suite, which the
  graph does not appear to index at all (0 File nodes matched `e2e/` in any
  query I ran, though I did not run a query targeting `e2e/` specifically —
  I found the e2e files via this grep, not the graph).

## Confidence

- **Q1: High.** Both client consumers (Orders .NET, Tracking Python) and the
  server (Users Node) are directly confirmed via graph queries 1-2 and file
  reads. The one soft spot: I did not locate *where* Users' own TS stub
  generation is invoked (no `grep`/graph search run for a Users-side
  equivalent of Tracking's `generate_grpc_stubs.py`) — flagged in Graph gaps.
- **Q2: High.** This answer is sourced almost entirely from
  `services/users/CLAUDE.md`, which is an authoritative, current,
  human-maintained checklist for exactly this scenario (§2a/§2b explicitly
  say "an endpoint without X is an incomplete change"). Low graph dependency
  by nature — this is a process question, not a call-graph question.
- **Q3: Medium-high.** The Tracking-internal blast radius and the
  events-pipeline blast radius are both directly confirmed (graph queries 6
  and 8, plus file reads). The e2e test blast radius was found by grep, not
  the graph — I could not verify whether the graph indexes `e2e/tests/*` at
  all (no query specifically targeted that directory), so I cannot rule out
  the graph having missed something grep also missed. The claim "Orders does
  not reference the status enum's literal values" is a **negative claim from
  absence of hits**, not a confirmed exhaustive search of Orders' `TrackingDto`
  code — I did not read `TrackingDto` or its consumers directly.

## Graph gaps

- **`GetUserById` split across two node labels.** The generated gRPC methods
  surfaced as `Method` nodes, not `Function` nodes, so my first query (using
  `Function`) silently returned 0 rows instead of erroring — I had to guess
  the right label and retry. A query that guesses wrong here looks like "no
  callers exist," which is indistinguishable from a real dead-code finding
  unless you already suspect a label mismatch.
- **`IMPORTS` edge did not resolve Python module-to-module imports for
  `domain/status.py`** (query 7, 0 rows) despite grep confirming
  `update_status.py` and `commands/*` do import `TrackingStatus` from it.
  Either the Python import resolution doesn't handle this project's relative
  import style, or the module node's `file_path` property doesn't match what
  I filtered on. This is the same class of gap the task brief warned about
  (unlabeled relationships silently dropping filters) — worth flagging even
  though I used a labeled `IMPORTS` edge here.
- **No evidence the graph indexes `e2e/` at all.** I never got a hit under
  `e2e/` from any graph query in this session (all such files came from grep).
  I did not run a query specifically scoped to `f.file_path CONTAINS 'e2e'` to
  confirm this one way or the other, so this is a suspected gap, not a
  confirmed one.
- **String-literal contents are invisible to the graph by design** — it
  indexes code structure (functions, calls, imports), not literal values.
  Both Q1 (proto field names) and Q3 (enum string values, error-message
  interpolation, email copy, template-key slugs) required reading actual file
  contents to find every place a *value*, not a *symbol*, is duplicated. A
  pure graph-based answer to either question would have been incomplete —
  it would have named the right *files* (via `CALLS`/`IMPORTS` reachability)
  but missed *why* each file needs to change.
- **No false positives observed this session** — unlike the task brief's
  warning about a route existing only in a test assertion, every result I
  spot-checked (the `GetUserById` Method hits, the events-pipeline File hits)
  matched real production code paths when read directly, not test-only
  artifacts. I did not encounter the specific "test assertion masquerading as
  a route" failure mode described in the brief.
