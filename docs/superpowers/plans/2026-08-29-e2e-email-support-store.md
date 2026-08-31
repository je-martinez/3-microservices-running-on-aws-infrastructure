---
title: "E2E Email-Support Store Implementation Plan"
type: plan
area: events-pipeline
status: draft
created: 2026-08-29
updated: 2026-08-29
tags:
  - type/plan
  - area/events-pipeline
  - status/draft
propagates-to:
  - "[[events-pipeline-design]]"
  - "[[testing]]"
  - "[[plans/index]]"
---

# E2E Email-Support Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the E2E suite a queryable record of every email the pipeline renders — correlated by run, carrying the full HTML and the plaintext code — without weakening a single existing email assertion.

**Architecture:** The events-pipeline writes one document per rendered email into a NEW MongoDB collection (`e2e_emails`), separate from the production `events` collection and gated behind an E2E flag. A TTL index expires documents automatically. The Playwright suite reads them over a Lambda Function URL (verified working on Floci), because DocumentDB's port 27017 is not published to the host and the e2e package has no Mongo driver.

**Tech Stack:** TypeScript, MongoDB driver (already a dependency of events-pipeline), Zod, Terraform (`aws_lambda_function_url`), Playwright, Vitest.

**Spec:** None — this design was settled in conversation on 2026-08-29 and is captured in this plan's Design Decisions section below. The investigation it grew out of is `docs/lessons/2026-08-29-the-emulator-was-the-ceiling-not-the-code.md`.

**Branch:** `feature/tracking-go-migration` (already open as PR #74). Commit per task.

---

## Design Decisions

These were decided explicitly. Do not re-litigate them mid-implementation.

**1. The store is an ADDITIONAL channel. The email still decides pass/fail.**
Specs keep calling `waitForEmailTo(...)` and keep extracting the OTP from the
real message. This store adds per-run correlation, the rendered HTML, and
diagnostics for when an email is late. It does **not** make the 8 email-timing
failures pass, because their cause is Floci's ~1 event/s delivery ceiling, not
the test harness. **A spec that stops asserting the email is not a passing
spec** — that rule comes from `CLAUDE.md` and this plan does not bend it.

**2. Why not read the code from the store instead.**
It would turn 8 red specs green in an afternoon and silently delete the only
coverage proving email is delivered end to end. The failures are honest signal
about a local emulator limit; hiding them is worse than seeing them.

**3. Why the events-pipeline writes it, not the Cognito trigger.**
`infra/modules/cognito/otp-challenge-lambda/index.mjs` mints the OTP but ships
**zero dependencies on purpose** — its only import is `node:crypto`, and it
hand-rolls SigV4 to call SQS. Adding a Mongo driver there would destroy that
property. The pipeline already has a MongoClient, already renders the HTML, and
already sees the plaintext code in the in-memory envelope.

**4. Why a Function URL and not an endpoint on Users.**
Whoever writes the data should serve it. Users has no Mongo access today, and
giving it some to serve a test fixture is a wider blast radius than one
E2E-gated route on the function that already owns the collection.
**Verified on 2026-08-29:** Floci supports `create-function-url-config`, the URL
resolves from the host, and an HTTP request reached the running function
(HTTP 200 in 8.5s). Note `list-function-url-configs` is broken on Floci (returns
an S3 `NoSuchBucket` XML error) — use `get-function-url-config`, which works.

**5. Plaintext codes are persisted ONLY here, ONLY under the flag.**
`src/domain/redact-payload.ts` strips `code` from the production event document
deliberately, and `auth-otp-requested.ts` carries a comment explaining that even
a Zod error message must stay credential-free. That protection is NOT being
weakened: the production document keeps its redaction, and the code appears only
in `e2e_emails`, only when `E2E_TESTING_ENABLED` is true, and only for a
TTL-bounded window. The collection must never be enabled in a deployed
environment.

**6. A separate collection, not a field on the event document.**
`events` is production data with a unique index on `event_id` and a fixed shape.
Test fixtures do not belong in it, and a TTL index on a production collection
would eventually delete real records.

## Global Constraints

- **pnpm only** — never `npm` or `yarn`. Use `pnpm --filter @3mrai/events-pipeline <script>`.
- **Run `nvm use` before any Node command** (repo pins Node via `.nvmrc`).
- **Never log** passwords, tokens, full request bodies, or a plaintext email. Emails are logged as `email_hash`; auth flows may log a masked form.
- **Never log the OTP/reset code**, in any branch, including error paths. It is written to the store, never to a log line.
- The e2e package gets **no new runtime dependency** — it talks HTTP, exactly like `mailpit-client.ts` does.
- **Do not edit anything under `e2e/tests/`** except the two spec files Task 8 names explicitly. `git diff --stat -- e2e/tests/` is reviewed.
- Everything under `docs/` is written by the **`obsidian-vault` agent**, never directly.
- Conventional Commits, one commit per task. **Never commit without the user's explicit confirmation** — leave work in the tree and present the A/B/C/D/E menu.
- New env vars must flow through `make env-file` (generated files, never hand-edited) and be declared in `.env.example`.

## File Structure

**New files**
| Path | Responsibility |
|---|---|
| `functions/events-pipeline/src/e2e/email-record.ts` | The document shape + Zod schema + the `EmailRecord` type. Pure data, no I/O. |
| `functions/events-pipeline/src/e2e/email-store.ts` | `E2eEmailStore`: `record()`, `query()`, `ensureE2eIndexes()`. Owns the collection name and the TTL index. |
| `functions/events-pipeline/src/e2e/http-query.ts` | Parses the Function URL event, authorizes it, calls the store, shapes the JSON response. |
| `functions/events-pipeline/tests/e2e/email-store.test.ts` | Unit tests for the store against a mocked collection. |
| `functions/events-pipeline/tests/e2e/http-query.test.ts` | Unit tests for parsing, auth and response shaping. |
| `e2e/support/email-store-client.ts` | Playwright-side HTTP client. Mirrors `mailpit-client.ts` in style. |

**Modified files**
| Path | Change |
|---|---|
| `functions/events-pipeline/src/shared/config/env.ts` | Add `E2E_TESTING_ENABLED`, `E2E_EMAIL_TTL_SECONDS`, `E2E_QUERY_TOKEN`. |
| `functions/events-pipeline/src/email/sender.ts` | Accept an optional `record` callback so the store write happens where the send happens. |
| `functions/events-pipeline/src/handlers/*.ts` (5 files) | Pass `code` and `runId` through to `sendEmail` where they exist. |
| `functions/events-pipeline/src/handler.ts` | Add the HTTP branch to the `HandlerEvent` union; bootstrap the E2E indexes. |
| `functions/events-pipeline/src/domain/envelope.ts` | Add optional `run_id`. |
| `services/users/src/shared/messaging/event-publisher.ts` | Propagate `run_id` from an inbound header onto published envelopes. |
| `infra/modules/lambda/{main,variables,outputs}.tf` | Optional `aws_lambda_function_url`. |
| `infra/environments/local/main.tf` | Enable the URL for the events function; pass the new env vars. |
| `infra/scripts/…` + `.env.example` | Surface the Function URL through `make env-file`. |
| `e2e/support/global-setup.ts` | Mint the run id. |
| `e2e/support/api-client.ts`, `gateway-client.ts` | Send the run id header. |
| `e2e/tests/otp.spec.ts`, `e2e/tests/gateway/otp-flow.spec.ts` | Add store-backed diagnostics **alongside** the existing email assertions. |

---
## Tasks

### Task 1: The email record shape and its config

**Files:**
- Create: `functions/events-pipeline/src/e2e/email-record.ts`
- Modify: `functions/events-pipeline/src/shared/config/env.ts`
- Test: `functions/events-pipeline/tests/e2e/email-record.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `EmailRecord` (type), `EmailRecordSchema` (Zod), `E2E_EMAILS_COLLECTION` (const `"e2e_emails"`); and on the env module: `env.E2E_TESTING_ENABLED: boolean`, `env.E2E_EMAIL_TTL_SECONDS: number`, `env.E2E_QUERY_TOKEN: string | undefined`.

- [ ] **Step 1: Write the failing test**

Create `functions/events-pipeline/tests/e2e/email-record.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EmailRecordSchema, E2E_EMAILS_COLLECTION } from "#e2e/email-record";

// A valid record, spelled out so a reader sees the whole shape at once.
const valid = {
  run_id: "run_2026-08-29T12-00-00_abc123",
  to: "e2e+uuid@example.com",
  subject: "Your one-time code",
  template_key: "auth-otp",
  html: "<html><body>123456</body></html>",
  code: "123456",
  event_id: "evt_abc",
  trace_id: "1fe7e1b6afff0da2990ff65247a85ee2",
  created_at: new Date("2026-08-29T12:00:00.000Z"),
  expires_at: new Date("2026-08-29T13:00:00.000Z"),
};

describe("EmailRecordSchema", () => {
  it("accepts a fully populated record", () => {
    expect(EmailRecordSchema.parse(valid)).toMatchObject({ to: valid.to, code: "123456" });
  });

  it("accepts a record with no code, because most emails carry none", () => {
    // user-created, order-created and the five tracking templates have no code.
    // Absent, NOT null — the repo's logging convention omits unknown fields
    // rather than writing null, and the same rule applies to what we persist.
    const { code, ...withoutCode } = valid;
    const parsed = EmailRecordSchema.parse(withoutCode);
    expect(parsed).not.toHaveProperty("code");
  });

  it("accepts a record with no trace_id, because a span is not always active", () => {
    const { trace_id, ...withoutTrace } = valid;
    expect(() => EmailRecordSchema.parse(withoutTrace)).not.toThrow();
  });

  it("rejects a record with no run_id", () => {
    // run_id is the whole point: a record that cannot be attributed to a run
    // is noise in a shared collection.
    const { run_id, ...withoutRun } = valid;
    expect(() => EmailRecordSchema.parse(withoutRun)).toThrow();
  });

  it("rejects an empty html body", () => {
    // An empty string would silently pass a truthiness check downstream while
    // proving nothing about what was rendered.
    expect(() => EmailRecordSchema.parse({ ...valid, html: "" })).toThrow();
  });

  it("names the collection separately from the production one", () => {
    expect(E2E_EMAILS_COLLECTION).toBe("e2e_emails");
    expect(E2E_EMAILS_COLLECTION).not.toBe("events");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
nvm use && cd functions/events-pipeline && pnpm exec vitest run tests/e2e/email-record.test.ts
```

Expected: FAIL — `Cannot find module '#e2e/email-record'`.

- [ ] **Step 3: Create the record module**

Create `functions/events-pipeline/src/e2e/email-record.ts`:

```ts
import { z } from "zod";

// Deliberately NOT the production `events` collection. That one holds real
// records under a unique index on event_id and must never carry a TTL — a TTL
// on production data is a scheduled data-loss bug. This collection is test
// fixture data and is expected to disappear.
export const E2E_EMAILS_COLLECTION = "e2e_emails";

// One document per email the pipeline actually rendered and handed to SES.
//
// `code` is the plaintext OTP or reset code. It is redacted from the production
// event document on purpose (see #domain/redact-payload) and that redaction is
// NOT relaxed — this collection is written only when E2E_TESTING_ENABLED is on,
// holds only TTL-bounded rows, and must never be enabled in a deployed
// environment.
//
// Optional fields are OMITTED rather than null, matching the repo-wide logging
// contract: an absent field means "did not apply", and null would force every
// reader to handle a third state.
export const EmailRecordSchema = z.object({
  run_id: z.string().min(1),
  to: z.string().email(),
  subject: z.string().min(1),
  template_key: z.string().min(1),
  // Non-empty: an empty body would satisfy a truthiness check while proving
  // nothing about what was rendered.
  html: z.string().min(1),
  code: z.string().min(1).optional(),
  event_id: z.string().min(1),
  // Omitted when no span is active — the same rule logger.ts follows rather
  // than writing an all-zero id.
  trace_id: z.string().optional(),
  created_at: z.date(),
  expires_at: z.date(),
});

export type EmailRecord = z.infer<typeof EmailRecordSchema>;
```

- [ ] **Step 4: Add the subpath import**

In `functions/events-pipeline/package.json`, add `"#e2e/*": "./src/e2e/*.ts"` to the existing `imports` map, following the spelling already used for `#domain/*` and `#email/*`.

- [ ] **Step 5: Add the three env vars**

In `functions/events-pipeline/src/shared/config/env.ts`, alongside the existing `DOCDB_*` entries:

```ts
  // Gates the whole E2E email store: the write, the indexes and the HTTP query
  // route. Default FALSE, and the default is the safety property — a deployed
  // environment that never sets it stores no plaintext codes and serves no
  // query route.
  E2E_TESTING_ENABLED: z.enum(["true", "false"]).optional(),

  // How long an e2e_emails document survives. One hour is far longer than any
  // suite run (~5 minutes) and short enough that a forgotten local stack is not
  // holding codes overnight.
  E2E_EMAIL_TTL_SECONDS: z.coerce.number().positive().default(3600),

  // Shared secret for the query route. Optional so a local stack works without
  // it, but http-query.ts REFUSES to serve when it is unset — see Task 4.
  E2E_QUERY_TOKEN: z.string().min(1).optional(),
```

And export the derived boolean next to the existing `docdbEchoCommands`:

```ts
export const e2eTestingEnabled = parsed.E2E_TESTING_ENABLED === "true";
```

- [ ] **Step 6: Run the tests**

```bash
nvm use && cd functions/events-pipeline && pnpm exec vitest run tests/e2e/email-record.test.ts && pnpm exec tsc --noEmit
```

Expected: 6 tests PASS, typecheck clean.

- [ ] **Step 7: Leave the work in the tree**

Do not commit. Report to the main session, which presents the A/B/C/D/E menu.
Proposed message:

```
feat(events-pipeline): define the E2E email record and its config
```

---

### Task 2: The store — write, query, and a TTL index

**Files:**
- Create: `functions/events-pipeline/src/e2e/email-store.ts`
- Test: `functions/events-pipeline/tests/e2e/email-store.test.ts`

**Interfaces:**
- Consumes: `EmailRecord`, `EmailRecordSchema`, `E2E_EMAILS_COLLECTION` from `#e2e/email-record`; `env`, `e2eTestingEnabled` from `#shared/config/env`.
- Produces:
  - `ensureE2eIndexes(db: Db): Promise<void>`
  - `class E2eEmailStore` with `constructor(db: Db)`, `record(input: EmailRecordInput): Promise<void>`, `query(filter: EmailQuery): Promise<EmailRecord[]>`
  - `type EmailRecordInput = Omit<EmailRecord, "created_at" | "expires_at">`
  - `type EmailQuery = { runId: string; to?: string; templateKey?: string; limit?: number }`

- [ ] **Step 1: Write the failing test**

Create `functions/events-pipeline/tests/e2e/email-store.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "mongodb";
import { E2eEmailStore, ensureE2eIndexes } from "#e2e/email-store";

const insertOne = vi.fn(async () => ({ acknowledged: true }));
const createIndex = vi.fn(async () => "idx");
const toArray = vi.fn(async () => []);
const limit = vi.fn(() => ({ toArray }));
const sort = vi.fn(() => ({ limit }));
const find = vi.fn(() => ({ sort }));

const db = {
  collection: vi.fn(() => ({ insertOne, createIndex, find })),
} as unknown as Db;

const input = {
  run_id: "run_abc",
  to: "e2e+uuid@example.com",
  subject: "Your one-time code",
  template_key: "auth-otp",
  html: "<html>123456</html>",
  code: "123456",
  event_id: "evt_abc",
  trace_id: "1fe7e1b6afff0da2990ff65247a85ee2",
};

beforeEach(() => vi.clearAllMocks());

describe("ensureE2eIndexes", () => {
  it("creates a TTL index that expires documents at expires_at", async () => {
    await ensureE2eIndexes(db);
    // expireAfterSeconds: 0 means "expire AT the date in this field", which is
    // what lets each document carry its own lifetime.
    expect(createIndex).toHaveBeenCalledWith({ expires_at: 1 }, { expireAfterSeconds: 0 });
  });

  it("creates the query index the HTTP route actually uses", async () => {
    await ensureE2eIndexes(db);
    expect(createIndex).toHaveBeenCalledWith({ run_id: 1, to: 1 });
  });
});

describe("E2eEmailStore.record", () => {
  it("stamps created_at and derives expires_at from the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00.000Z"));
    await new E2eEmailStore(db).record(input);
    const [doc] = insertOne.mock.calls[0] as unknown as [Record<string, Date>];
    expect(doc.created_at).toEqual(new Date("2026-08-29T12:00:00.000Z"));
    // Default E2E_EMAIL_TTL_SECONDS is 3600.
    expect(doc.expires_at).toEqual(new Date("2026-08-29T13:00:00.000Z"));
    vi.useRealTimers();
  });

  it("rejects a record that does not satisfy the schema", async () => {
    // The store validates rather than trusting its caller: a malformed document
    // in this collection would fail at QUERY time, in a test, far from here.
    await expect(new E2eEmailStore(db).record({ ...input, to: "not-an-email" })).rejects.toThrow();
    expect(insertOne).not.toHaveBeenCalled();
  });
});

describe("E2eEmailStore.query", () => {
  it("always scopes by run_id, so one run cannot see another's mail", async () => {
    await new E2eEmailStore(db).query({ runId: "run_abc" });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ run_id: "run_abc" }));
  });

  it("adds recipient and template to the filter when given", async () => {
    await new E2eEmailStore(db).query({ runId: "run_abc", to: "a@b.com", templateKey: "auth-otp" });
    expect(find).toHaveBeenCalledWith({ run_id: "run_abc", to: "a@b.com", template_key: "auth-otp" });
  });

  it("returns newest first and caps the result set", async () => {
    await new E2eEmailStore(db).query({ runId: "run_abc" });
    expect(sort).toHaveBeenCalledWith({ created_at: -1 });
    expect(limit).toHaveBeenCalledWith(50);
  });

  it("never returns more than the hard cap even when asked for more", async () => {
    // A caller asking for 10000 would otherwise stream the whole collection
    // through a Lambda response.
    await new E2eEmailStore(db).query({ runId: "run_abc", limit: 10_000 });
    expect(limit).toHaveBeenCalledWith(200);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
nvm use && cd functions/events-pipeline && pnpm exec vitest run tests/e2e/email-store.test.ts
```

Expected: FAIL — `Cannot find module '#e2e/email-store'`.

- [ ] **Step 3: Write the store**

Create `functions/events-pipeline/src/e2e/email-store.ts`:

```ts
import type { Db } from "mongodb";
import { env } from "#shared/config/env";
import { E2E_EMAILS_COLLECTION, EmailRecordSchema, type EmailRecord } from "#e2e/email-record";

// The caller supplies the facts; the store owns the clock.
export type EmailRecordInput = Omit<EmailRecord, "created_at" | "expires_at">;

export type EmailQuery = {
  runId: string;
  to?: string;
  templateKey?: string;
  limit?: number;
};

const DEFAULT_LIMIT = 50;

// A hard ceiling, not a default. Without it a caller could ask for the whole
// collection and stream it through a Lambda response body.
const MAX_LIMIT = 200;

// `expireAfterSeconds: 0` is the per-document form: MongoDB deletes the row at
// the instant named by the indexed DATE FIELD, rather than N seconds after it.
// That is what lets each record carry its own lifetime, and it is why
// expires_at is computed at write time instead of being a fixed collection
// policy.
export async function ensureE2eIndexes(db: Db): Promise<void> {
  const collection = db.collection(E2E_EMAILS_COLLECTION);
  await collection.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  // The exact shape the HTTP query filters on. Compound and ordered: run_id
  // first because every query is scoped by it.
  await collection.createIndex({ run_id: 1, to: 1 });
}

export class E2eEmailStore {
  constructor(private readonly db: Db) {}

  async record(input: EmailRecordInput): Promise<void> {
    const createdAt = new Date();
    const doc = EmailRecordSchema.parse({
      ...input,
      created_at: createdAt,
      expires_at: new Date(createdAt.getTime() + env.E2E_EMAIL_TTL_SECONDS * 1000),
    });
    await this.db.collection(E2E_EMAILS_COLLECTION).insertOne(doc);
  }

  async query(filter: EmailQuery): Promise<EmailRecord[]> {
    // run_id is unconditional. Workers and reruns share this collection, so an
    // unscoped query would hand a spec another run's mail and pass for the
    // wrong reason.
    const mongoFilter: Record<string, string> = { run_id: filter.runId };
    if (filter.to) mongoFilter.to = filter.to;
    if (filter.templateKey) mongoFilter.template_key = filter.templateKey;

    const capped = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    return (await this.db
      .collection(E2E_EMAILS_COLLECTION)
      .find(mongoFilter)
      .sort({ created_at: -1 })
      .limit(capped)
      .toArray()) as unknown as EmailRecord[];
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
nvm use && cd functions/events-pipeline && pnpm exec vitest run tests/e2e/email-store.test.ts && pnpm exec tsc --noEmit
```

Expected: 8 tests PASS, typecheck clean.

- [ ] **Step 5: Leave the work in the tree**

Proposed message:

```
feat(events-pipeline): add the TTL-backed E2E email store
```

---

### Task 3: Record every email at the point it is sent

**Files:**
- Modify: `functions/events-pipeline/src/email/sender.ts`
- Modify: `functions/events-pipeline/src/handlers/auth-otp-requested.ts`
- Modify: `functions/events-pipeline/src/handlers/password-reset-requested.ts`
- Modify: `functions/events-pipeline/src/handlers/user-created.ts`
- Modify: `functions/events-pipeline/src/handlers/order-created.ts`
- Modify: `functions/events-pipeline/src/handlers/tracking-status-changed.ts`
- Modify: `functions/events-pipeline/src/pipeline/process-record.ts`
- Modify: `functions/events-pipeline/src/handlers/index.ts`
- Test: `functions/events-pipeline/tests/e2e/email-recording.test.ts`

**Interfaces:**
- Consumes: `E2eEmailStore`, `EmailRecordInput` from `#e2e/email-store`; `e2eTestingEnabled` from `#shared/config/env`.
- Produces: `SendEmailParams` gains two optional fields — `code?: string` and `recordEmail?: (params: { to: string; subject: string; html: string; templateKey: string; code?: string }) => Promise<void>`. `HandlerMap` becomes `Record<string, (envelope: Envelope, deps: HandlerDeps) => Promise<void>>` where `HandlerDeps = { recordEmail?: RecordEmailFn }`.

**Why the callback, rather than importing the store into the sender:** the sender
is a pure transport with a lazy SES client and no database concept. Handing it a
callback keeps the Mongo dependency in the composition root and keeps the sender
unit-testable without a Db. It also puts the write at the exact point where an
email is known to have been rendered AND handed to SES — recording earlier would
log emails that were never sent.

- [ ] **Step 1: Write the failing test**

Create `functions/events-pipeline/tests/e2e/email-recording.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn(async () => ({}));
vi.mock("@aws-sdk/client-ses", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-ses")>("@aws-sdk/client-ses");
  return { ...actual, SESClient: vi.fn(() => ({ send })) };
});

const { sendEmail, resetSesClientForTests } = await import("#email/sender");

beforeEach(() => {
  vi.clearAllMocks();
  resetSesClientForTests();
});

describe("sendEmail with a recorder", () => {
  it("records the email it just sent, including the html and code", async () => {
    const recordEmail = vi.fn(async () => {});
    await sendEmail({
      to: "e2e+uuid@example.com",
      subject: "Your one-time code",
      html: "<html>123456</html>",
      templateKey: "auth-otp",
      code: "123456",
      recordEmail,
    });
    expect(recordEmail).toHaveBeenCalledWith({
      to: "e2e+uuid@example.com",
      subject: "Your one-time code",
      html: "<html>123456</html>",
      templateKey: "auth-otp",
      code: "123456",
    });
  });

  it("records AFTER the send, so a failed send records nothing", async () => {
    // The store answers "what was delivered". Recording before the send would
    // make it answer "what was attempted", and a spec reading it during a SES
    // outage would see mail that never left.
    send.mockRejectedValueOnce(new Error("SES is down"));
    const recordEmail = vi.fn(async () => {});
    await expect(
      sendEmail({ to: "a@b.com", subject: "s", html: "<p>h</p>", templateKey: "auth-otp", recordEmail }),
    ).rejects.toThrow();
    expect(recordEmail).not.toHaveBeenCalled();
  });

  it("does not fail the record when recording throws", async () => {
    // A broken test fixture must never fail a real email. The record is
    // best-effort by construction.
    const recordEmail = vi.fn(async () => {
      throw new Error("mongo is down");
    });
    await expect(
      sendEmail({ to: "a@b.com", subject: "s", html: "<p>h</p>", templateKey: "auth-otp", recordEmail }),
    ).resolves.toBeUndefined();
  });

  it("sends normally when no recorder is supplied", async () => {
    await sendEmail({ to: "a@b.com", subject: "s", html: "<p>h</p>", templateKey: "auth-otp" });
    expect(send).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
nvm use && cd functions/events-pipeline && pnpm exec vitest run tests/e2e/email-recording.test.ts
```

Expected: FAIL — `recordEmail` is not part of `SendEmailParams`.

- [ ] **Step 3: Extend the sender**

In `functions/events-pipeline/src/email/sender.ts`, extend the params type:

```ts
export type RecordEmailFn = (params: {
  to: string;
  subject: string;
  html: string;
  templateKey: string;
  code?: string;
}) => Promise<void>;

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  templateKey: string;
  // The plaintext OTP/reset code, when this template carries one. Passed
  // through to the recorder ONLY — it is never logged and never reaches SES
  // metadata.
  code?: string;
  // Optional E2E hook. Absent in production, where nothing wires it.
  recordEmail?: RecordEmailFn;
}
```

At the end of `sendEmail`, after the SES call has succeeded:

```ts
  // AFTER the send, and swallowing its own failures. This store answers "what
  // was delivered"; recording before the send would make it answer "what was
  // attempted". And a failure here is a broken test fixture, which must never
  // turn into a failed email — so it is logged at WARN and the record returns
  // normally.
  if (params.recordEmail) {
    try {
      await params.recordEmail({
        to: params.to,
        subject: params.subject,
        html: params.html,
        templateKey: params.templateKey,
        code: params.code,
      });
    } catch (err) {
      appLogger.warn(
        { app_event: "e2e_email_record_failed", template_key: params.templateKey, err },
        "could not record the e2e email copy",
      );
    }
  }
```

- [ ] **Step 4: Thread the dependency through the dispatch**

In `src/pipeline/process-record.ts`, widen the handler signature:

```ts
// Handlers now receive an optional recorder alongside the envelope. Only the
// E2E store uses it; production passes nothing and the handlers behave exactly
// as before.
export type HandlerDeps = { recordEmail?: RecordEmailFn };
export type HandlerMap = Record<string, (envelope: Envelope, deps: HandlerDeps) => Promise<void>>;
```

and pass `deps.handlerDeps ?? {}` at the single call site where a handler is invoked.

In each of the five handlers, accept the second parameter and forward it. For
`auth-otp-requested.ts` the `sendEmail` call becomes:

```ts
export async function authOtpRequestedHandler(
  envelope: Envelope,
  deps: HandlerDeps = {},
): Promise<void> {
  // …unchanged validation and render…
  await sendEmail({
    to: result.data.email,
    subject: "Your one-time code",
    html,
    templateKey: "auth-otp",
    // The store is the only consumer of this field. The production event
    // document keeps its redaction (see #domain/redact-payload) — this does
    // not relax it.
    code: result.data.code,
    recordEmail: deps.recordEmail,
  });
}
```

`password-reset-requested.ts` takes the identical change with `code: result.data.code`
and `templateKey: "forgot-password"`. The other three (`user-created`,
`order-created`, `tracking-status-changed`) forward `recordEmail: deps.recordEmail`
and pass **no** `code` — those templates carry none.

- [ ] **Step 5: Run the tests**

```bash
nvm use && cd functions/events-pipeline && pnpm test && pnpm exec tsc --noEmit
```

Expected: the 4 new tests PASS and all 254 pre-existing tests still PASS. If a
handler test fails on arity, add the `deps` parameter with its `= {}` default —
do not change the assertion.

- [ ] **Step 6: Leave the work in the tree**

Proposed message:

```
feat(events-pipeline): record every sent email through an optional hook
```

---
### Task 4: The HTTP query route

**Files:**
- Create: `functions/events-pipeline/src/e2e/http-query.ts`
- Test: `functions/events-pipeline/tests/e2e/http-query.test.ts`

**Interfaces:**
- Consumes: `E2eEmailStore`, `EmailQuery` from `#e2e/email-store`; `env`, `e2eTestingEnabled` from `#shared/config/env`.
- Produces:
  - `interface FunctionUrlEvent { requestContext?: { http?: { method?: string } }; queryStringParameters?: Record<string, string | undefined> | null; headers?: Record<string, string | undefined> }`
  - `interface FunctionUrlResponse { statusCode: number; headers: Record<string, string>; body: string }`
  - `isFunctionUrlEvent(event: unknown): event is FunctionUrlEvent`
  - `handleEmailQuery(event: FunctionUrlEvent, store: E2eEmailStore): Promise<FunctionUrlResponse>`

**Security shape, decided before the code:** this route serves plaintext OTP
codes. Three independent conditions must ALL hold or it returns 404 — never 401,
never 403, and never a body that distinguishes them:
1. `E2E_TESTING_ENABLED` is `true`
2. `E2E_QUERY_TOKEN` is set (an unset token disables the route rather than
   opening it — the failure mode of a missing secret must be closed)
3. The request presents that token in `x-e2e-token`, compared in constant time

404 rather than 403 because a 403 confirms the route exists on a function that
holds credentials. The Cognito trigger already uses `constantTimeEquals` for the
same class of comparison (`infra/modules/cognito/otp-challenge-lambda/index.mjs`).

- [ ] **Step 1: Write the failing test**

Create `functions/events-pipeline/tests/e2e/http-query.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const query = vi.fn(async () => []);
const store = { query } as unknown as import("#e2e/email-store").E2eEmailStore;

function eventWith(overrides: Record<string, unknown> = {}) {
  return {
    requestContext: { http: { method: "GET" } },
    headers: { "x-e2e-token": "secret-token" },
    queryStringParameters: { runId: "run_abc" },
    ...overrides,
  };
}

// The module reads env at import time, so each case re-imports with a fresh
// environment rather than mutating a cached module.
async function load(envOverrides: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(envOverrides)) vi.stubEnv(k, v);
  return await import("#e2e/http-query");
}

const ENABLED = { E2E_TESTING_ENABLED: "true", E2E_QUERY_TOKEN: "secret-token" };

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("handleEmailQuery — access control", () => {
  it("serves the query when enabled and correctly authenticated", async () => {
    const { handleEmailQuery } = await load(ENABLED);
    const res = await handleEmailQuery(eventWith(), store);
    expect(res.statusCode).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_abc" }));
  });

  it("404s when the flag is off, without touching the store", async () => {
    const { handleEmailQuery } = await load({ ...ENABLED, E2E_TESTING_ENABLED: "false" });
    const res = await handleEmailQuery(eventWith(), store);
    expect(res.statusCode).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it("404s when no token is configured, rather than serving unauthenticated", async () => {
    // The closed failure mode: a missing secret must disable the route, never
    // open it.
    const { handleEmailQuery } = await load({ E2E_TESTING_ENABLED: "true" });
    const res = await handleEmailQuery(eventWith(), store);
    expect(res.statusCode).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it("404s on a wrong token", async () => {
    const { handleEmailQuery } = await load(ENABLED);
    const res = await handleEmailQuery(
      eventWith({ headers: { "x-e2e-token": "wrong" } }),
      store,
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns the same status and body for a wrong token as for a disabled route", async () => {
    // Indistinguishable on purpose: a different response would confirm the
    // route exists on a function holding live credentials.
    const disabled = await load({ ...ENABLED, E2E_TESTING_ENABLED: "false" });
    const disabledRes = await disabled.handleEmailQuery(eventWith(), store);
    const enabled = await load(ENABLED);
    const wrongTokenRes = await enabled.handleEmailQuery(
      eventWith({ headers: { "x-e2e-token": "wrong" } }),
      store,
    );
    expect(wrongTokenRes.statusCode).toBe(disabledRes.statusCode);
    expect(wrongTokenRes.body).toBe(disabledRes.body);
  });
});

describe("handleEmailQuery — request handling", () => {
  it("400s when runId is missing, because an unscoped query is never correct", async () => {
    const { handleEmailQuery } = await load(ENABLED);
    const res = await handleEmailQuery(eventWith({ queryStringParameters: {} }), store);
    expect(res.statusCode).toBe(400);
  });

  it("passes the optional filters through", async () => {
    const { handleEmailQuery } = await load(ENABLED);
    await handleEmailQuery(
      eventWith({
        queryStringParameters: { runId: "run_abc", to: "a@b.com", templateKey: "auth-otp", limit: "5" },
      }),
      store,
    );
    expect(query).toHaveBeenCalledWith({
      runId: "run_abc",
      to: "a@b.com",
      templateKey: "auth-otp",
      limit: 5,
    });
  });

  it("405s on a non-GET method", async () => {
    const { handleEmailQuery } = await load(ENABLED);
    const res = await handleEmailQuery(
      eventWith({ requestContext: { http: { method: "DELETE" } } }),
      store,
    );
    expect(res.statusCode).toBe(405);
  });

  it("returns JSON with a count and the emails", async () => {
    const { handleEmailQuery } = await load(ENABLED);
    query.mockResolvedValueOnce([{ to: "a@b.com", code: "123456" }] as never);
    const res = await handleEmailQuery(eventWith(), store);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ count: 1, emails: [{ to: "a@b.com", code: "123456" }] });
  });
});

describe("isFunctionUrlEvent", () => {
  it("recognises a Function URL event", async () => {
    const { isFunctionUrlEvent } = await load(ENABLED);
    expect(isFunctionUrlEvent(eventWith())).toBe(true);
  });

  it("does not mistake an SQS batch for one", async () => {
    // The discriminator the handler relies on. A false positive here would
    // route real messages into the query path and drop them.
    const { isFunctionUrlEvent } = await load(ENABLED);
    expect(isFunctionUrlEvent({ Records: [{ messageId: "m", body: "{}" }] })).toBe(false);
  });

  it("does not mistake the metrics tick for one", async () => {
    const { isFunctionUrlEvent } = await load(ENABLED);
    expect(isFunctionUrlEvent({ "detail-type": "3mrai.metrics.tick" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
nvm use && cd functions/events-pipeline && pnpm exec vitest run tests/e2e/http-query.test.ts
```

Expected: FAIL — `Cannot find module '#e2e/http-query'`.

- [ ] **Step 3: Write the route**

Create `functions/events-pipeline/src/e2e/http-query.ts`:

```ts
import { timingSafeEqual } from "node:crypto";
import { env, e2eTestingEnabled } from "#shared/config/env";
import type { E2eEmailStore } from "#e2e/email-store";

export interface FunctionUrlEvent {
  requestContext?: { http?: { method?: string } };
  queryStringParameters?: Record<string, string | undefined> | null;
  headers?: Record<string, string | undefined>;
}

export interface FunctionUrlResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// The discriminator for handler.ts's event union. Keyed on requestContext.http,
// which an SQS batch and the EventBridge tick both lack — a false positive here
// would route real messages into the query path and silently drop them.
export function isFunctionUrlEvent(event: unknown): event is FunctionUrlEvent {
  return typeof (event as FunctionUrlEvent)?.requestContext?.http?.method === "string";
}

const NOT_FOUND: FunctionUrlResponse = {
  statusCode: 404,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "Not Found" }),
};

function json(statusCode: number, payload: unknown): FunctionUrlResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

// Constant-time, and length-safe: timingSafeEqual throws on a length mismatch,
// so the lengths are compared first — and that comparison leaks only the
// length, which an attacker supplying the candidate already knows.
function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function handleEmailQuery(
  event: FunctionUrlEvent,
  store: E2eEmailStore,
): Promise<FunctionUrlResponse> {
  // Three conditions, all required, all answering 404 — never 401 or 403, and
  // never a body that distinguishes them. This route serves plaintext OTP
  // codes; a 403 would confirm it exists on a function that holds them.
  //
  // An UNSET token disables the route rather than opening it: the failure mode
  // of a missing secret must be closed.
  if (!e2eTestingEnabled) return NOT_FOUND;
  if (!env.E2E_QUERY_TOKEN) return NOT_FOUND;

  const headers = event.headers ?? {};
  // Function URL header names arrive lowercased, but a proxy may not; accept
  // either spelling rather than failing obscurely.
  const presented = headers["x-e2e-token"] ?? headers["X-E2E-Token"];
  if (!tokenMatches(presented, env.E2E_QUERY_TOKEN)) return NOT_FOUND;

  const method = event.requestContext?.http?.method;
  if (method !== "GET") return json(405, { message: "Method Not Allowed" });

  const params = event.queryStringParameters ?? {};
  const runId = params.runId;
  // An unscoped query is never correct: workers and reruns share this
  // collection, so a missing runId would hand back another run's mail.
  if (!runId) return json(400, { message: "runId is required" });

  const emails = await store.query({
    runId,
    to: params.to,
    templateKey: params.templateKey,
    limit: params.limit ? Number(params.limit) : undefined,
  });

  return json(200, { count: emails.length, emails });
}
```

- [ ] **Step 4: Run the tests**

```bash
nvm use && cd functions/events-pipeline && pnpm exec vitest run tests/e2e/http-query.test.ts && pnpm exec tsc --noEmit
```

Expected: 12 tests PASS, typecheck clean.

- [ ] **Step 5: Leave the work in the tree**

Proposed message:

```
feat(events-pipeline): serve E2E email records over an authenticated route
```

---

### Task 5: Wire the route and the store into the handler

**Files:**
- Modify: `functions/events-pipeline/src/handler.ts`
- Test: `functions/events-pipeline/tests/handler.test.ts` (append)

**Interfaces:**
- Consumes: `isFunctionUrlEvent`, `handleEmailQuery`, `FunctionUrlEvent` from `#e2e/http-query`; `E2eEmailStore`, `ensureE2eIndexes` from `#e2e/email-store`; `e2eTestingEnabled` from `#shared/config/env`.
- Produces: `HandlerEvent` becomes `SqsEvent | MetricsTickEvent | FunctionUrlEvent`; the handler returns `FunctionUrlResponse` for HTTP events.

**Ordering matters.** The HTTP check must come FIRST in the dispatch chain.
`processBatch` reads `event.Records.length`, so an HTTP event reaching it throws
`Cannot read properties of undefined (reading 'length')` — which is exactly what
the live Function URL probe produced on 2026-08-29 before this branch existed.

- [ ] **Step 1: Write the failing test**

Append to `functions/events-pipeline/tests/handler.test.ts`:

```ts
// The Function URL branch. This is a THIRD event shape on one function, and the
// dispatch order is load-bearing: processBatch reads event.Records.length, so
// an HTTP event that falls through to it throws
// "Cannot read properties of undefined (reading 'length')" — observed live
// against Floci before this branch existed.
describe("handler — Function URL requests", () => {
  it("routes an HTTP event to the query route instead of the batch path", async () => {
    const res = (await handler({
      requestContext: { http: { method: "GET" } },
      headers: {},
      queryStringParameters: { runId: "run_abc" },
    } as never)) as unknown as { statusCode: number };
    // 404 because no token is configured in this test env — the point is that
    // it answered as HTTP rather than throwing on Records.length.
    expect(res.statusCode).toBe(404);
  });

  it("still processes an SQS batch normally", async () => {
    const result = await handler({ Records: [sqsRecord("msg-1", envelope())] });
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it("still processes the metrics tick normally", async () => {
    await handler({ "detail-type": "3mrai.metrics.tick" } as never);
    expect(spansNamed("metrics-tick")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
nvm use && cd functions/events-pipeline && pnpm exec vitest run tests/handler.test.ts -t "Function URL"
```

Expected: FAIL — the HTTP event falls through and throws on `Records.length`.

- [ ] **Step 3: Add the branch**

In `src/handler.ts`, widen the union and dispatch HTTP first:

```ts
type HandlerEvent = SqsEvent | MetricsTickEvent | FunctionUrlEvent;
```

At the top of the exported handler, before the metrics-tick check:

```ts
  // FIRST in the chain, and the order is load-bearing rather than stylistic:
  // processBatch reads event.Records.length, so an HTTP event reaching it dies
  // with "Cannot read properties of undefined (reading 'length')".
  //
  // No tracing span here. This route is test-support scaffolding, not a
  // business flow, and giving it a CONSUMER span would put fixture reads in the
  // same waterfall as real order and email work.
  if (isFunctionUrlEvent(event)) {
    const client = await getMongoClient();
    const db = client.db(env.DOCDB_DATABASE);
    return (await handleEmailQuery(event, new E2eEmailStore(db))) as never;
  }
```

In `processBatch`, after the existing `ensureIndexes(db)` call, add the E2E
indexes under the flag:

```ts
      if (!indexesEnsured) {
        await ensureIndexes(db);
        // Only under the flag: a deployed environment that never enables E2E
        // creates no TTL index and no fixture collection at all.
        if (e2eTestingEnabled) await ensureE2eIndexes(db);
        indexesEnsured = true;
      }
```

And build the recorder that Task 3's handlers consume, passing it into
`processRecord`:

```ts
    // Absent entirely when the flag is off, so production handlers receive
    // `undefined` and skip the write with no branch of their own.
    const recordEmail = e2eTestingEnabled
      ? async (params: Parameters<RecordEmailFn>[0]) => {
          await new E2eEmailStore(db).record({
            ...params,
            template_key: params.templateKey,
            run_id: envelope.run_id ?? "unattributed",
            event_id: envelope.event_id,
            trace_id: trace.getActiveSpan()?.spanContext().traceId,
          });
        }
      : undefined;
```

- [ ] **Step 4: Run the full suite**

```bash
nvm use && cd functions/events-pipeline && pnpm test && pnpm exec tsc --noEmit && pnpm run lint
```

Expected: the 3 new tests PASS, all pre-existing tests still PASS.

- [ ] **Step 5: Leave the work in the tree**

Proposed message:

```
feat(events-pipeline): dispatch Function URL requests to the E2E query route
```

---
### Task 6: Carry the run id from the test to the envelope

**Files:**
- Modify: `functions/events-pipeline/src/domain/envelope.ts`
- Modify: `services/users/src/shared/messaging/event-publisher.ts`
- Modify: `infra/modules/cognito/otp-challenge-lambda/index.mjs`
- Modify: `services/users/src/shared/auth/cognito-auth-provider.ts`
- Test: `functions/events-pipeline/tests/domain/envelope.test.ts` (append), `services/users/tests/…/event-publisher.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Envelope` gains `run_id?: string`. Users' request context gains `runId`, read from the `x-e2e-run-id` header.

**The OTP path is the hard one, and it is why this task exists as its own unit.**
The OTP envelope is published by the Cognito trigger, which Cognito invokes —
the HTTP request's context never reaches it. The repo already solved this exact
problem for tracing: `cognito-auth-provider.ts` puts a `traceparent` into
`ClientMetadata`, which is "the only caller-controlled field Cognito forwards to
a trigger verbatim", and the trigger shape-checks it and copies it onto the SQS
message. **The run id rides the same seam**, for the same reason. Do not invent
a second mechanism.

- [ ] **Step 1: Write the failing test**

Append to `functions/events-pipeline/tests/domain/envelope.test.ts`:

```ts
it("accepts an envelope carrying a run id", () => {
  // Optional because production traffic never carries one; the field exists
  // solely to attribute a fixture record to the suite run that caused it.
  const parsed = EnvelopeSchema.parse({ ...validEnvelope, run_id: "run_abc" });
  expect(parsed.run_id).toBe("run_abc");
});

it("accepts an envelope with no run id", () => {
  expect(() => EnvelopeSchema.parse(validEnvelope)).not.toThrow();
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
nvm use && cd functions/events-pipeline && pnpm exec vitest run tests/domain/envelope.test.ts
```

Expected: FAIL — `run_id` is stripped by the schema, so `parsed.run_id` is `undefined`.

- [ ] **Step 3: Add the field to the envelope**

In `functions/events-pipeline/src/domain/envelope.ts`, inside the schema:

```ts
  // E2E ONLY. Identifies the Playwright run that ultimately caused this event,
  // so the e2e_emails fixture collection can be scoped per run. Optional and
  // absent in production traffic — the same "omitted, never null" rule the rest
  // of the envelope follows.
  run_id: z.string().min(1).optional(),
```

- [ ] **Step 4: Publish it from Users**

In `services/users/src/shared/messaging/event-publisher.ts`, spread the run id
into every published envelope, following the existing spread-or-nothing idiom
used for optional fields:

```ts
      ...(runId ? { run_id: runId } : {}),
```

Read `runId` from the request context that Users already threads for logging.
Populate that context from the `x-e2e-run-id` header, ANDed with
`E2E_TESTING_ENABLED` — the same gate that governs `x-e2e-source` at
`services/users/src/features/users/http/routes.ts:375-377`. An unflagged
environment ignores the header entirely.

- [ ] **Step 5: Carry it through Cognito's ClientMetadata**

In `services/users/src/shared/auth/cognito-auth-provider.ts`, add the run id to
the `ClientMetadata` object that already carries `traceparent`:

```ts
  // Rides the same seam as traceparent, for the same reason: Cognito invokes
  // the CUSTOM_AUTH trigger, so this request's context never reaches it, and
  // ClientMetadata is the only caller-controlled field Cognito forwards
  // verbatim. Omitted (never blank) when there is no run id, matching how
  // traceparent behaves with no active span.
  ...(runId ? { runId } : {}),
```

In `infra/modules/cognito/otp-challenge-lambda/index.mjs`, read it back in
`publishOtpRequested` and put it on the envelope. Shape-check it the way
`traceparent` is checked — the trigger must not trust an arbitrary string from
the wire:

```js
// Shape-checked, not trusted: this value arrives from a caller-controlled field
// and lands in a database document. The suite's own ids match this pattern.
const RUN_ID_PATTERN = /^run_[A-Za-z0-9_:.-]{1,64}$/;
const runId = event.request?.clientMetadata?.runId;
const safeRunId = typeof runId === "string" && RUN_ID_PATTERN.test(runId) ? runId : undefined;
```

and include `...(safeRunId ? { run_id: safeRunId } : {})` in the envelope object.

**This adds no dependency** — it is a regex and an object spread, so the
trigger's zero-dependency property is preserved.

- [ ] **Step 6: Run both test suites**

```bash
nvm use
cd functions/events-pipeline && pnpm test && cd -
cd services/users && pnpm test && cd -
cd infra/modules/cognito/otp-challenge-lambda && pnpm exec vitest run
```

Expected: all PASS, including the trigger's own `index.test.mjs`.

- [ ] **Step 7: Leave the work in the tree**

Proposed message:

```
feat(users): propagate an E2E run id onto published envelopes
```

---

### Task 7: Terraform — the Function URL and the new env vars

**Files:**
- Modify: `infra/modules/lambda/main.tf`, `infra/modules/lambda/variables.tf`, `infra/modules/lambda/outputs.tf`
- Modify: `infra/environments/local/main.tf`
- Modify: `.env.example`
- Modify: the env-file generator under `infra/scripts/`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `EVENTS_QUERY_URL` and `E2E_QUERY_TOKEN` in `.env.local.infra`, consumed by Task 8's client.

**Verified against Floci on 2026-08-29 before this plan was written:**
`create-function-url-config` works, `get-function-url-config` returns the config,
the URL resolves from the host, and a GET reached the running function (HTTP 200
in 8.5s). **`list-function-url-configs` is BROKEN** — it returns an S3
`NoSuchBucket` XML error. Use `get-function-url-config` in any script or check.

- [ ] **Step 1: Add the optional URL to the module**

In `infra/modules/lambda/variables.tf`:

```hcl
variable "enable_function_url" {
  description = "Create a public Function URL for this Lambda. Local/E2E only — the events function uses it to serve the E2E email-query route."
  type        = bool
  default     = false
}
```

In `infra/modules/lambda/main.tf`:

```hcl
# Count-gated so no environment gets a public URL unless it asks for one.
#
# AuthType NONE is acceptable here ONLY because the handler itself authenticates
# every request against E2E_QUERY_TOKEN and answers 404 when the token is unset
# or wrong (see functions/events-pipeline/src/e2e/http-query.ts). The URL is not
# the security boundary; the token is.
resource "aws_lambda_function_url" "this" {
  count              = var.enable_function_url ? 1 : 0
  function_name      = aws_lambda_function.this.function_name
  authorization_type = "NONE"
}
```

In `infra/modules/lambda/outputs.tf`:

```hcl
output "function_url" {
  description = "The Function URL, or an empty string when disabled."
  value       = var.enable_function_url ? aws_lambda_function_url.this[0].function_url : ""
}
```

- [ ] **Step 2: Enable it for the events function**

In `infra/environments/local/main.tf`, on the events module: set
`enable_function_url = true`, and add to `environment_variables`:

```hcl
    E2E_TESTING_ENABLED   = "true"
    E2E_EMAIL_TTL_SECONDS = "3600"
    E2E_QUERY_TOKEN       = var.e2e_query_token
```

Declare `e2e_query_token` as a variable with a local default and a comment
saying it is a local-only fixture secret, not a production credential.

- [ ] **Step 3: Surface both values through `make env-file`**

Add `EVENTS_QUERY_URL` (from the module's `function_url` output) and
`E2E_QUERY_TOKEN` to the AUTO-GENERATED block of `.env.local.infra`, following
the existing generator's shape. Add both to `.env.example` with a one-line
comment each — `.env.example` is the committed contract.

**Never hand-edit a generated env file**; the generator is the only writer.

- [ ] **Step 4: Apply and verify against the live emulator**

```bash
cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga
make infra-up && make env-file && make redeploy-lambdas
grep -E 'EVENTS_QUERY_URL|E2E_QUERY_TOKEN' .env.local.infra
aws --endpoint-url=http://localhost:4566 lambda get-function-url-config \
  --function-name 3mrai-local-events --region us-east-1
```

Expected: both vars present; the config returns a `FunctionUrl` of the shape
`http://<hash>.lambda-url.us-east-1.localhost:4566/`.

- [ ] **Step 5: Verify the route answers end to end**

```bash
URL=$(grep '^EVENTS_QUERY_URL=' .env.local.infra | cut -d= -f2-)
TOKEN=$(grep '^E2E_QUERY_TOKEN=' .env.local.infra | cut -d= -f2-)
curl -s -o /dev/null -w '%{http_code}\n' "${URL}?runId=probe"
curl -s -o /dev/null -w '%{http_code}\n' -H "x-e2e-token: ${TOKEN}" "${URL}?runId=probe"
```

Expected: **404** without the token, **200** with it. If the first returns 200,
stop — the auth gate is not wired and the route is serving codes unauthenticated.

- [ ] **Step 6: Leave the work in the tree**

Proposed message:

```
build(infra): expose the events Lambda's E2E query route over a Function URL
```

---

### Task 8: The Playwright client, and diagnostics that do not replace assertions

**Files:**
- Create: `e2e/support/email-store-client.ts`
- Modify: `e2e/support/global-setup.ts`
- Modify: `e2e/support/api-client.ts`, `e2e/support/gateway-client.ts`
- Modify: `e2e/tests/otp.spec.ts`, `e2e/tests/gateway/otp-flow.spec.ts`

**Interfaces:**
- Consumes: `EVENTS_QUERY_URL`, `E2E_QUERY_TOKEN` from `.env.local.infra`.
- Produces:
  - `currentRunId(): string`
  - `fetchRecordedEmails(opts: { to?: string; templateKey?: string; limit?: number }): Promise<RecordedEmail[]>`
  - `describeRecordedEmails(to: string): Promise<string>` — a human-readable diagnostic block for failure messages.

**The rule this task must not break:** the specs keep waiting for and asserting
the REAL email. The store is used for *diagnostics on failure* and for
correlation — never as the source of the OTP code. A reviewer should be able to
delete this task's spec changes and still have the suite prove email delivery.

- [ ] **Step 1: Mint the run id in global setup**

In `e2e/support/global-setup.ts`, before the health checks:

```ts
// One id per `playwright test` invocation, exported to the workers through the
// environment because globalSetup and the workers are separate processes.
// Timestamp first so ids sort chronologically when read straight out of Mongo.
process.env.E2E_RUN_ID = `run_${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
console.log(`[global-setup] run id: ${process.env.E2E_RUN_ID}`);
```

- [ ] **Step 2: Send it on every request**

In `e2e/support/api-client.ts` and `e2e/support/gateway-client.ts`, add
`"x-e2e-run-id": process.env.E2E_RUN_ID ?? ""` to the same `extraHTTPHeaders`
object that already carries `X-E2E-Source`.

- [ ] **Step 3: Write the client**

Create `e2e/support/email-store-client.ts`:

```ts
// Reads the pipeline's E2E email records over the events Lambda's Function URL.
//
// This is a DIAGNOSTIC channel, not an assertion channel. Specs still wait for
// the real message in Mailpit and still extract the OTP from it; what this adds
// is the ability to say WHY an email assertion failed — was it rendered and
// sent at all, and when — instead of only "nothing arrived in 45s".
//
// No new dependency: plain fetch, exactly like mailpit-client.ts.

export interface RecordedEmail {
  run_id: string;
  to: string;
  subject: string;
  template_key: string;
  html: string;
  code?: string;
  event_id: string;
  trace_id?: string;
  created_at: string;
  expires_at: string;
}

export function currentRunId(): string {
  const runId = process.env.E2E_RUN_ID;
  if (!runId) {
    throw new Error(
      "E2E_RUN_ID is not set. global-setup mints it; a spec run outside the " +
        "harness (or with globalSetup skipped) will not have one.",
    );
  }
  return runId;
}

function config(): { url: string; token: string } | null {
  const url = process.env.EVENTS_QUERY_URL;
  const token = process.env.E2E_QUERY_TOKEN;
  // Absent config disables diagnostics rather than failing a spec: this channel
  // must never be the reason a test goes red.
  if (!url || !token) return null;
  return { url, token };
}

export async function fetchRecordedEmails(
  opts: { to?: string; templateKey?: string; limit?: number } = {},
): Promise<RecordedEmail[]> {
  const cfg = config();
  if (!cfg) return [];

  const params = new URLSearchParams({ runId: currentRunId() });
  if (opts.to) params.set("to", opts.to);
  if (opts.templateKey) params.set("templateKey", opts.templateKey);
  if (opts.limit) params.set("limit", String(opts.limit));

  try {
    const res = await fetch(`${cfg.url}?${params}`, {
      headers: { "x-e2e-token": cfg.token },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { emails?: RecordedEmail[] };
    return body.emails ?? [];
  } catch {
    // Same rule as above — a diagnostic channel that throws would convert a
    // clear email-timing failure into a confusing connection error.
    return [];
  }
}

// A block to append to a failure message. Answers the question the bare
// "nothing arrived" message cannot: did the pipeline ever render and send it?
export async function describeRecordedEmails(to: string): Promise<string> {
  const emails = await fetchRecordedEmails({ to });
  if (emails.length === 0) {
    return (
      `\n[email-store] No email was RECORDED for ${to} in this run either, so the ` +
      `pipeline never rendered one — the event did not reach the consumer, rather ` +
      `than the mail being slow.`
    );
  }
  const lines = emails.map(
    (e) => `  - "${e.subject}" (${e.template_key}) recorded at ${e.created_at}, trace ${e.trace_id ?? "n/a"}`,
  );
  return (
    `\n[email-store] The pipeline DID render and send ${emails.length} email(s) for ${to}:\n` +
    lines.join("\n") +
    `\nSo this is a DELIVERY-TIMING failure, not a lost event. See ` +
    `docs/lessons/2026-08-29-the-emulator-was-the-ceiling-not-the-code.md.`
  );
}
```

- [ ] **Step 4: Add diagnostics to the two OTP specs, keeping every assertion**

In `e2e/tests/otp.spec.ts` and `e2e/tests/gateway/otp-flow.spec.ts`, wrap the
existing email wait so a failure carries the store's verdict. The
`waitForEmailTo` call and the code extraction stay exactly as they are:

```ts
  let message;
  try {
    [message] = await waitForEmailTo(email, {
      timeoutMs: EMAIL_TIMEOUT_MS,
      matching: (m) => m.Subject === OTP_SUBJECT,
      description: `the "${OTP_SUBJECT}" email`,
    });
  } catch (err) {
    // The assertion still fails — this only explains WHY. Without it, a late
    // email and a lost event produce the identical message.
    throw new Error(`${(err as Error).message}${await describeRecordedEmails(email)}`);
  }
```

- [ ] **Step 5: Verify the diagnostics work and nothing else changed**

```bash
nvm use && cd e2e
npx playwright test tests/otp.spec.ts tests/gateway/otp-flow.spec.ts --reporter=line
git diff --stat -- e2e/tests/
```

Expected: the specs behave as before (green on a quiet stack), and
`git diff --stat -- e2e/tests/` shows **only** those two files.

- [ ] **Step 6: Prove the diagnostic fires**

Run the full suite, which is the condition that produces late email:

```bash
nvm use && cd e2e && npx playwright test --reporter=line 2>&1 | tail -20
```

Expected: still ~8 email-timing failures — **that is the correct outcome, not a
regression** — but each now carries an `[email-store]` block saying whether the
pipeline rendered and sent the mail. Confirm at least one failure shows the
"DID render and send" verdict, which is the evidence that the emails are late
rather than lost.

- [ ] **Step 7: Leave the work in the tree**

Proposed message:

```
test(e2e): correlate emails per run and explain timing failures
```

---

### Task 9: Documentation

**Files:**
- Modify (via the `obsidian-vault` agent ONLY): `functions/events-pipeline/CLAUDE.md`, `docs/domains/events-pipeline/specs/events-pipeline-design.md`, `e2e/CLAUDE.md`
- Modify: `.env.example` (if Task 7 left anything undocumented)

Per the repo's doc-propagation convention, a feature is not done when the code
works — it is done when the decisions have reached the notes that own them.

- [ ] **Step 1: Route the vault updates through the agent**

Dispatch `obsidian-vault` with: the new `e2e_emails` collection and its TTL
index; the Function URL as a third event shape on the events Lambda; the
security posture (404-on-everything, closed-by-default token); the fact that
Floci's `list-function-url-configs` is broken while `get` works; and the rule
that this store is additive and must never become the source of the OTP in a
spec.

- [ ] **Step 2: Validate the vault**

```bash
nvm use && node scripts/validate-vault.mjs
```

Expected: passes. A pre-existing "Propagation debt" count for older notes is the
gate working, not a failure.

- [ ] **Step 3: Leave the work in the tree**

Proposed message:

```
docs(events-pipeline): document the E2E email store and its query route
```

---

## Self-Review

**Spec coverage.** There is no separate spec; the Design Decisions section is the
spec, and each of its six decisions maps to a task: (1) and (2) are enforced by
Task 8's structure and its explicit "keeps every assertion" rule; (3) by Task 3
putting the write in the pipeline and Task 6 keeping the trigger dependency-free;
(4) by Tasks 4, 5 and 7; (5) by Task 1's schema comment, Task 4's three-condition
gate and Task 7's flag; (6) by `E2E_EMAILS_COLLECTION` being asserted different
from `events` in Task 1.

**Placeholder scan.** No TBDs, no "handle errors appropriately", no "similar to
Task N". Every code step carries the actual code.

**Type consistency.** `EmailRecordInput` (Task 2) is `Omit<EmailRecord,
"created_at" | "expires_at">`, and Task 5's recorder supplies exactly the missing
fields (`run_id`, `event_id`, `trace_id`, `template_key`) plus the sender's four.
`RecordEmailFn` is defined once in Task 3 and referenced by name in Task 5.
`EmailQuery` (Task 2) matches the parameters Task 4 builds and the query string
Task 8 sends. `FunctionUrlEvent`/`FunctionUrlResponse` are defined in Task 4 and
consumed in Task 5.

**Known gap, stated rather than hidden.** This plan does **not** make the 8
email-timing specs pass. Their cause is Floci's ~1 event/s ceiling, measured and
recorded in `docs/lessons/2026-08-29-the-emulator-was-the-ceiling-not-the-code.md`.
What it delivers is per-run correlation, the rendered HTML, and a failure message
that distinguishes "late" from "lost" — which is the difference between a flake
you re-run and a bug you chase. The ninth failure (`cache.spec.ts`, which varies
between runs) is untouched by this work and remains open.

## Related

- [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]] — the investigation this plan grew out of, and why the 8 email failures are an emulator ceiling rather than a harness defect.
- [[events-pipeline-design]] — the service this plan extends.
- [[floci-sqs-lambda-docdb-support]] — what Floci does and does not emulate, including the DocumentDB access constraints this plan works around.
- [[testing]] — the three-layer testing convention this plan must not weaken.
- [[logging-context]] — the "omitted, never null" rule the record schema follows, and the PII rules that keep the code out of every log line.
