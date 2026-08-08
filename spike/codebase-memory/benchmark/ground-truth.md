# Ground Truth — change-impact tasks

Established by the controller **before** reading either arm's answers, so completeness
is scored against a fixed reference rather than against whichever arm sounded more
thorough.

Derived by exhaustive grep across `services/`, `functions/`, and `e2e/`, excluding
`node_modules`.

## Q1 — add a field to a message in `proto/users.proto`

`users.proto` is owned by Users and consumed across **four** components in **three
languages**:

| Consumer | File | Language | Note |
|---|---|---|---|
| Users | `services/users/src/shared/grpc/server.ts` | TypeScript | Loads the proto at runtime via `@grpc/proto-loader` |
| Orders | `services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj` | C# | Compiles the proto at build time |
| Tracking | `services/tracking/src/shared/grpc/generated/users_pb2.py` | Python | **Committed generated stubs** |
| Tracking | `services/tracking/scripts/generate_grpc_stubs.py` | Python | Regeneration script |
| Tracking | `services/tracking/tests/test_grpc_stubs.py` | Python | Test asserting stubs match the proto |
| events-pipeline | `functions/events-pipeline/src/handlers/order-created.ts` | TypeScript | Calls the Users gRPC surface |

**The trap:** Tracking commits *generated* stubs and has a test that fails if they
drift from the proto. An answer that names only "the three services" without naming
stub regeneration is incomplete in a way that would break CI.

Runtime-loaded (Users) vs build-time-compiled (Orders) vs pre-generated-and-committed
(Tracking) means the same proto change propagates by three different mechanisms.

## Q2 — add an HTTP endpoint to Users

Fully documented in `services/users/CLAUDE.md` §2a/§2b and `docs/shared/conventions/testing.md`:

1. Route implementation with **named** Zod schemas registered via `z.globalRegistry.add`
2. Regenerate `openapi.yaml` (`pnpm generate:openapi`) and commit it with the change
3. `pnpm build && pnpm lint && pnpm test`
4. Three test layers: unit/integration, internal E2E, **gateway E2E with a real Cognito JWT**

This is the control: a question documentation answers well. Both arms should get it.

## Q3 — rename a value in the Tracking delivery-status enum

**10 files across 3 components**, crossing a service boundary over SQS:

| Component | Files |
|---|---|
| Tracking (source of truth) | `domain/status.py`, `domain/models.py`, `commands/update_status.py`, `commands/test_mode_progression.py`, `api/schemas.py`, `shared/audit/audit_actor.py` |
| events-pipeline (consumer) | `handlers/tracking-status-changed.ts`, `handlers/index.ts`, `email/catalog.ts` |
| E2E | `e2e/support/mailpit-client.ts` |

Plus ~8 Tracking test files that assert on status values.

**The trap:** `functions/events-pipeline/src/email/catalog.ts` maps status values to
**email templates**. Rename a status without updating it and users silently stop
receiving the right notification — no compile error, no test failure in Tracking.
This is the cross-service, cross-language coupling a documentation index is least
likely to capture and a code graph is most likely to catch.

## Scoring

For each question and arm:

- **Complete** — names every consumer above, including the trap
- **Partial** — names the obvious consumers, misses the trap
- **Incomplete** — misses a whole service or component

Confidence calibration is scored separately: an arm claiming *high* confidence while
scoring Partial is worse than one claiming *medium* and scoring the same — miscalibrated
confidence is what causes a real change to ship broken.
