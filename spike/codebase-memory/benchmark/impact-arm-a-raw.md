## Answers

### Q1 — New field on a message in `proto/users.proto`

Depends on which message. Assuming the common case, a new field on `UserResponse` (or `Address`):

1. **`proto/users.proto`** — the field definition itself.
2. **`services/users` (server/producer side)**:
   - `services/users/src/shared/grpc/server.ts` (lines ~49-54) — the `GetUserById` handler builds
     the outgoing wire object **by hand** (`{ id, email, full_name, cognito_sub }`), not by codegen.
     A new field must be added to this literal explicitly or it is silently dropped, even though
     `defaults: true` is set on the proto-loader. Note: as of this read, `address` is defined on
     `UserResponse` in the .proto but is **not currently populated** in this literal — an existing
     gap, not something the new field introduces.
   - `services/users/src/features/users/domain/user.ts` / `UserRow` — if the new field's source
     data isn't already on the domain object, it needs adding here (and to whatever query resolves
     it, e.g. `queries/get-me.ts`'s `getUserById`).
   - No `.ts` types are generated from the proto here — Users loads it dynamically at runtime via
     `@grpc/proto-loader` (`loadSync`) + `grpc.loadPackageDefinition`, with `keepCase: true`. So
     there's no "regenerate stubs" step on this side, but also no compiler to catch a missed field.
3. **`services/orders` (client/consumer side)**:
   - `services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj` (line ~31) references
     the proto directly (`Protobuf Include="..\..\..\..\proto\users.proto" GrpcServices="Both"`) —
     `dotnet build` regenerates the C# stubs (`Users.V1.UserResponse`, etc.) automatically; no
     manual step needed for the generated code itself.
   - `services/orders/src/Orders.Infrastructure/Grpc/UserDirectoryGrpcClient.cs` — hand-written
     mapping from the generated `UserResponse`/`Address` onto `CallerProfile`/`CallerAddress`. A new
     field must be added to this mapping (`ResolveCallerAsync`, `ToAddress`) to actually be used;
     the generated stub will carry it, but nothing reads it otherwise.
   - `services/orders/src/Orders.Application/Identity/CallerProfile.cs` — the `CallerProfile` /
     `CallerAddress` records mirror the proto fields **one-for-one by hand** (explicit comment: "a
     frozen value object, not an evolving contract") — must add the field here too if it's meant to
     flow into Orders' domain.
   - Any downstream consumer of `CallerProfile`/`CallerAddress` in Orders (e.g.
     `Orders.Infrastructure/Orders/CreateOrderService.cs`, `ShippingAddressSnapshot.cs`) if the new
     field should propagate further (e.g. into `ORDER_CREATED`'s payload or the shipping snapshot).
4. **Dockerfiles** — both `services/users/Dockerfile` and `services/orders/Dockerfile` COPY the
   proto file explicitly at build/runtime; no change needed unless the file moves, but worth noting
   both images depend on this single shared file existing at the expected relative path.
5. **Tests** — `services/orders/tests/Orders.Tests/Infrastructure/UserDirectoryGrpcClientTests.cs`
   (has a test specifically for the email-mapping behavior — a new field of similar significance
   would likely need an analogous test). No dedicated Users-side test exercises `GetUserById`'s
   wire shape field-by-field that I found.
6. **NOT affected**: `services/tracking` — its own `tracking.v1.Address` message is a hand-mirrored
   duplicate (by explicit design, per the comment in `users.proto`) with **no proto import
   relationship** to `users.proto`. A new field on `users.v1.Address` does NOT propagate to
   Tracking's proto or code at all — they're deliberately decoupled, kept in sync "by hand" per the
   comment, and only if someone chooses to.

### Q2 — New HTTP endpoint on Users service

From `services/users/CLAUDE.md` §2a/§2b and `docs/shared/conventions/testing.md`:

1. **Route implementation**: add the route in `services/users/src/features/users/http/routes.ts`
   with a Zod `schema` (body/querystring/params/response), handler under the appropriate
   `commands/` or `queries/` folder (CQRS split), wired through Awilix DI.
2. **Request/response schemas**: register named (not inline/anonymous) Zod schemas in
   `services/users/src/features/users/http/schemas.ts` via `z.globalRegistry.add(schema, { id })`
   so Apidog shows real models, not inline blobs.
3. **Regenerate OpenAPI**: `nvm use && pnpm generate:openapi` — MUST be run and the regenerated
   `services/users/openapi.yaml` committed together with the code change. This is a hard rule
   ("GOLDEN RULE") in the service's CLAUDE.md.
4. **Test layer 1 — unit/integration**: vitest via `buildApp` with a mocked Awilix container.
5. **Test layer 2 — internal E2E**: Playwright spec at `e2e/tests/users.spec.ts` (the `internal`
   project), hitting `http://localhost:3000` directly with `x-user-id` faked.
6. **Test layer 3 — gateway E2E**: Playwright spec at `e2e/tests/gateway/users.spec.ts` (the
   `gateway` project), hitting `API_GATEWAY_URL` with a real Cognito JWT — this is explicitly
   called out as mandatory: "An endpoint without gateway E2E is an incomplete change," because it's
   the only layer that exercises JWT authorizer → njs → nginx routing → service, and this repo has
   shipped gateway-only bugs (404 for a missing route, 405 for a dropped path param, 500 from an
   underscore in a path regex) that were invisible to layers 1–2.
7. **Gateway routing (nginx)**: `infra/modules/compute/nginx/nginx.conf` — Users' routes fall
   through to the default `location /` block (line ~85), which already forwards to
   `users:3000`, so a **normal new `/v1/...` Users route likely needs no nginx.conf change**. This
   is unlike Orders/Tracking/products, which have their own explicit `location` blocks. (Caveat: if
   the new endpoint needs a path that could collide with another service's prefix — `/v1/orders`,
   `/v1/products`, `/v1/trackings` — or needs unprefixed rewriting like `/v1/health`, nginx.conf
   would need a new `location` block.)
8. **Auth wiring**: if the endpoint needs identity, it reads it from the `x-user-id` header (JWT
   `sub`, injected by the gateway) — no code changes needed to the authorizer itself unless the
   endpoint has new auth requirements.
9. **Verification**: `pnpm build && pnpm lint && pnpm test` must pass; confirm every route's
   body/params/response resolves to a named `$ref` (not inline) in the regenerated spec.

Not required unless the endpoint is stateful in a new way: DB migration (only if new fields/tables
are needed — not mentioned as generically required for "any new endpoint").

### Q3 — Rename a value in Tracking's delivery-status enum

Source of truth: `services/tracking/src/features/tracking/domain/status.py` — `TrackingStatus`
(`StrEnum`: `PLACED`, `PROCESSING`, `SHIPPED`, `OUT_FOR_DELIVERY`, `DELIVERED`), plus
`STATUS_ORDER`, `INITIAL_STATUS`, `TERMINAL_STATUS`, and `parse_status` (which raises `ValueError`
listing the valid values — case-sensitive, "a fixed wire contract shared with the proto" per its
own docstring, though I found no actual tracking status field in `proto/users.proto`, so I read
that as "external wire contract" generally, not literally the proto file I saw).

**Inside Tracking itself:**
- `services/tracking/src/features/tracking/domain/status.py` — the enum definition, `STATUS_ORDER`
  tuple, docstrings referencing the literal values.
- `services/tracking/src/features/tracking/domain/models.py` — comment "One of the five
  TrackingStatus values," column stored as plain `VARCHAR(50)` (no DB CHECK constraint found, so no
  schema migration is strictly required by the DB engine) — but **existing persisted rows with the
  old value become semantically invalid** (an existing row with the renamed status string would
  fail `parse_status` on next read/transition) unless a data migration (`UPDATE ... SET status =
  'NEW' WHERE status = 'OLD'`, and the same for `tracking_history`) accompanies the rename.
- `services/tracking/src/features/tracking/commands/{update_status.py, create_tracking.py,
  test_mode_progression.py}` — reference status values directly.
- `services/tracking/src/features/tracking/api/{schemas.py, init_tracking_router.py}` — `status:
  str` is untyped at the Pydantic boundary (deliberately, per an inline comment, so `400` handling
  stays centralized in `parse_status` rather than in FastAPI's validation) — so the API schema
  itself doesn't hardcode the enum values, but callers still need the string to match.
- `services/tracking/src/shared/audit/audit_actor.py` — matched in the earlier grep; likely an
  unrelated `AuditActor` enum with similarly-named constants worth double-checking, not confirmed
  as a status consumer specifically.
- Tests: `test_status_state_machine.py`, `test_repository.py`, `test_rest_carrier_status.py`,
  `test_rest_init_tracking.py`, `test_rest_reads.py`, `test_test_mode_progression.py`,
  `test_sqs_event_publisher.py`, `test_status_changed_emission.py`, `test_log_identity.py`,
  `test_rest_e2e_cleanup.py` — all reference status literals per the earlier grep.

**Outside Tracking (confirmed consumers elsewhere in the repo):**
- `functions/events-pipeline/src/handlers/tracking-status-changed.ts` — **hardcodes its own
  independent Zod enum**: `z.enum(["PLACED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY",
  "DELIVERED"])`, plus a `TEMPLATE_BY_STATUS` lookup map keyed by the same literal strings. This is
  NOT derived from Tracking's Python enum — it's a hand-duplicated string contract across the SQS
  event envelope. A rename here would cause the Lambda to reject the renamed value as an invalid
  payload (a `PermanentError`), i.e. **email + realtime notification silently break** for that
  status until updated.
- `functions/events-pipeline/src/email/catalog.ts` — five `tracking-status-changed-<status>`
  catalog keys (e.g. `tracking-status-changed-out-for-delivery`), built from
  `TEMPLATE_BY_STATUS`'s values, not the raw enum name, but still needs the corresponding key
  renamed/added.
- `functions/events-pipeline/emails/tracking-status-changed.tsx` — ONE react-email component
  rendering all five variants, with `status: "PLACED" | "PROCESSING" | ... ` as a TS union type
  and a `COPY` record keyed by that union — needs the literal updated in the type and the `COPY`
  map (not five separate files, so this is a single-file change).
- `functions/events-pipeline/src/handlers/index.ts` — matched in the initial grep (dispatch map);
  not individually re-read, but likely routes by event `type` (`TRACKING_STATUS_CHANGED`), not by
  status value, so probably unaffected — **not fully verified**.
- Realtime WebSocket path (`functions/realtime-events/`) — the design docs describe the same four
  transition statuses being pushed over the WebSocket by the events-pipeline's publisher
  (`shared/realtime/websocket-publisher`), sourced from the SAME `payload.status` string as the
  email path in `tracking-status-changed.ts` — so it inherits the same hardcoded-string risk, but I
  did not open `functions/realtime-events` source files directly to confirm no separate enum lives
  there.
- **E2E specs** (not opened line-by-line, but grep-confirmed to reference the literal status
  strings, 85 combined matches across 4 files): `e2e/tests/tracking.spec.ts`,
  `e2e/tests/gateway/tracking.spec.ts`, `e2e/tests/gateway/tracking-flow.spec.ts`,
  `e2e/tests/gateway/realtime-tracking.spec.ts` — these assert on the literal status strings
  (e.g. asserting the TestMode transition set `{PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED}`
  per `docs/shared/conventions/testing.md`), so a rename breaks these assertions until updated.
- **Documentation**: `docs/domains/tracking/specs/tracking-service-design.md`,
  `docs/domains/events-pipeline/specs/events-pipeline-design.md`,
  `docs/shared/conventions/testing.md`, plus several superpowers specs/plans — all reference the
  literal status names and would need updating per the repo's own doc-propagation convention.
- **Orders service**: grepped explicitly for `PLACED`/`OUT_FOR_DELIVERY` — **no matches** in
  `services/orders`. Orders consumes tracking data via `TrackingDto`/Tracking's batch read
  (mentioned in `services/orders/CLAUDE.md`) but I did not find literal status-string coupling
  there — **not exhaustively verified**, since I did not grep Orders for a generic `status` string
  match (only the two specific enum-value literals), so a looser match (e.g. `"SHIPPED"` alone, or
  a `TrackingDto.Status` field with its own comparisons) could exist and be missed.

## Files read

1. `proto/users.proto`
2. `services/users/src/features/users/grpc/get-user-by-id.ts`
3. `services/orders/src/Orders.Infrastructure/Grpc/UserDirectoryGrpcClient.cs` (via grep -n on csproj first, then full read)
4. `services/users/src/features/users/domain/user.ts`
5. `services/users/src/shared/grpc/server.ts`
6. `services/orders/tests/Orders.Tests/Infrastructure/UserDirectoryGrpcClientTests.cs` (grep only, not full read)
7. `services/orders/src/Orders.Application/Identity/CallerProfile.cs`
8. `services/users/src/features/users/queries/get-me.ts`
9. `docs/shared/conventions/testing.md`
10. `services/orders/CLAUDE.md` (auto-injected by harness, not explicitly opened)
11. `services/users/CLAUDE.md` (auto-injected by harness, not explicitly opened)
12. `infra/modules/compute/nginx/nginx.conf` (grep only)
13. `services/tracking/src/features/tracking/domain/status.py`
14. `functions/events-pipeline/src/handlers/tracking-status-changed.ts`
15. `functions/events-pipeline/src/email/catalog.ts` (grep, then targeted read of import lines)
16. `functions/events-pipeline/emails/tracking-status-changed.tsx` (grep only)
17. `services/tracking/CLAUDE.md` (auto-injected by harness, not explicitly opened)
18. `functions/events-pipeline/CLAUDE.md` (auto-injected by harness, not explicitly opened)
19. `services/tracking/src/features/tracking/api/schemas.py` (grep only)
20. `services/tracking/src/features/tracking/domain/models.py` (grep only, "VARCHAR" line)

Plus directory/grep-only operations that surfaced filenames without opening file contents
(counted as "touched" for completeness but not as full reads): `services/users/package.json`,
`services/users/Dockerfile`, `services/orders/Dockerfile`,
`services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj`, various `.cs` files
listed by a grep -l over `services/orders/src`, e2e spec files (grep -l and grep -n only), and a
repo-wide directory listing (`find . -maxdepth 2 -type d`).

## Answer sources

| Question # | File(s) that answered it | Position |
|---|---|---|
| 1 | `proto/users.proto` (message defs); `services/users/src/shared/grpc/server.ts` (hand-built wire object, the critical gap); `services/orders/.../UserDirectoryGrpcClient.cs` + `CallerProfile.cs` (hand-mirrored mapping); csproj proto reference (grep) | 1, 5, 3/7, csproj grep (early, untabled) |
| 2 | `services/users/CLAUDE.md` (§2a/§2b, auto-injected — not a numbered "open" action); `docs/shared/conventions/testing.md`; `infra/modules/compute/nginx/nginx.conf` (grep) | CLAUDE.md auto-injected ~after step 8; 9; 12 |
| 3 | `services/tracking/src/features/tracking/domain/status.py`; `functions/events-pipeline/src/handlers/tracking-status-changed.ts`; `functions/events-pipeline/src/email/catalog.ts`; `functions/events-pipeline/emails/tracking-status-changed.tsx`; `services/tracking/CLAUDE.md` (auto-injected) | 13, 14, 15, 16, + CLAUDE.md auto-injected |

## Confidence

| Question # | Confidence | What might be missing |
|---|---|---|
| 1 | Medium-high | Did not check for a `.proto`-derived type consumed anywhere else in Orders beyond the one client class (e.g. generated stub usage in test doubles/mocks under `obj/`/generated dirs I excluded). Did not verify whether any other service (Tracking) references `users.proto` at all — grep suggests no, but not exhaustively confirmed via full-file reads. Did not check `services/orders/tests/Orders.Tests/Api/OrdersApiFactory.cs` contents (only saw filename). |
| 2 | Medium-high | Did not open `services/users/src/features/users/http/routes.ts` or `schemas.ts` directly — relied on CLAUDE.md's description of the pattern rather than confirming the exact current route-registration code. Did not verify whether any new endpoint might require IAM/API Gateway resource changes in Terraform (`infra/`) beyond nginx — did not check `infra/` for a Users-specific API Gateway resource definition. |
| 3 | Medium | Did not open `functions/realtime-events/` source directly (only inferred from CLAUDE.md/testing.md prose that it shares the same status strings) — this is a real gap since Q3 explicitly asks about consumers outside Tracking. Did not fully verify Orders has zero coupling (only grepped two specific literals, not a broader `status` pattern, and not `TrackingDto` definition). Did not open `functions/events-pipeline/src/handlers/index.ts` fully. Did not check `services/tracking/src/shared/audit/audit_actor.py` content despite it matching the grep — flagged as unconfirmed in the answer. Data-migration implication (existing rows with the old value) is inferred from "VARCHAR(50), no CHECK constraint," not from finding an actual migration file for a prior rename.

## Total distinct files read

20
