// Reads the local Mailpit inbox — the last hop of the events-pipeline's email
// path, and the only place that proves an email was actually DELIVERED.
//
// What this closes: every layer below it stops short of the inbox. The pipeline's
// unit tests assert what a handler HANDS to sendEmail; its integration test
// (functions/events-pipeline/tests/email/sender.integration.test.ts) sends one
// email directly and reads it back. Neither exercises the real trigger — a user
// registering, an order being placed, a carrier moving a tracking — nor the
// producer → SQS → Lambda → SES → SMTP relay chain those actions set off. A
// broken producer, a queue the Lambda is not subscribed to, or a dispatch that
// silently drops an event type all leave those suites green and the user's inbox
// empty. Asserting here is what makes that visible.
//
// Style follows api-client.ts / gateway-client.ts: a base URL from the
// environment with an actionable failure when it is missing, and no
// test-specific logic — the specs decide WHAT to assert, this only fetches.

//: One message as Mailpit's search endpoint renders it. This is the SUMMARY
// shape, which is a strict subset of what `GET /message/{ID}` returns: the
// summary carries `Snippet` (a flattened text preview) where the full message
// carries `Text` and `HTML`. Only the fields the specs actually read are
// declared — Mailpit sends more (MessageID, Read, Cc, Bcc, ReplyTo, Tags, Size,
// Attachments), and typing fields nobody asserts on would invite drift.
export interface MailpitMessage {
  ID: string;
  Subject: string;
  From: { Name: string; Address: string };
  To: { Name: string; Address: string }[];
  Created: string;
  //: A plain-text flattening of the body, which is what makes a content
  // assertion possible without a second request for the full message.
  Snippet: string;
}

//: The search envelope. `messages` is the page; `total` counts every message in
// the WHOLE inbox, not the matches — do not assert on it (see the note in
// searchByRecipient).
interface MailpitSearchResponse {
  total: number;
  count: number;
  messages_count: number;
  messages: MailpitMessage[];
}

// Generated into `.env.local.infra` by `make env-file` and loaded by
// playwright.config.ts. The fallback matches the one the pipeline's integration
// test has always used, so a stack whose env files predate this variable still
// works rather than failing on a technicality.
function mailpitApiUrl(): string {
  return process.env.MAILPIT_API_URL ?? "http://localhost:8025/api/v1";
}

// Finds every message delivered to ONE address.
//
// ## Why an exact address is the whole safety mechanism
//
// Mailpit ACCUMULATES: it is a long-lived local container with no cleanup
// between runs (global-teardown.ts deletes rows from the three services and
// deliberately does not touch the inbox — see the note there). The local
// instance already holds ~150 messages from previous runs, so a query that
// matched anything but this run's own mail would assert against a PREVIOUS
// run's email and pass while the pipeline was completely broken.
//
// Two properties make this safe, and both were verified live rather than
// assumed:
//
//  1. Every address is unique per run. chance-factory.ts builds them as
//     `e2e+<crypto.randomUUID()>@example.com` — explicitly NOT from the seeded
//     Chance instance, precisely so parallel workers cannot collide.
//  2. Mailpit's `to:` is an EXACT-address match, not a substring one. Queried
//     live against an inbox of 148 messages whose addresses ALL begin `e2e+`,
//     `to:e2e@example.com` returned 0 matches while the full address returned
//     exactly its own 2. So a run cannot be contaminated by a sibling address
//     that merely shares a prefix.
//
// The address is always passed in by the caller, never defaulted or hardcoded:
// a spec asserts against the address IT created.
export async function searchByRecipient(address: string, limit = 50): Promise<MailpitMessage[]> {
  // encodeURIComponent, not raw interpolation: the addresses this suite
  // generates contain a `+`, which is decoded as a SPACE in a query string.
  // Unencoded, `to:e2e+<uuid>@example.com` reaches Mailpit as
  // `to:e2e <uuid>@example.com` and matches nothing — a false "no email
  // arrived" that would look exactly like a broken pipeline.
  const query = encodeURIComponent(`to:${address}`);
  const res = await fetch(`${mailpitApiUrl()}/search?query=${query}&limit=${limit}`);

  if (!res.ok) {
    throw new Error(
      `Mailpit search failed with ${res.status} at ${mailpitApiUrl()}/search — ` +
        `is the mailpit container up? \`docker compose up -d mailpit\`.`,
    );
  }

  // `messages`, never `total`: `total` is the size of the entire inbox (148 on a
  // local instance with two matches), so treating it as a match count would make
  // every assertion trivially true.
  const body = (await res.json()) as MailpitSearchResponse;
  return body.messages ?? [];
}

export interface WaitForEmailOptions {
  //: How long to keep looking before failing. Delivery crosses SQS → Lambda →
  // SES → SMTP → Mailpit, so it is asynchronous by nature.
  timeoutMs?: number;
  intervalMs?: number;
  //: Wait until at least this many messages have arrived for the address. The
  // journey spec needs it: one address receives a welcome email AND an order
  // email AND several tracking emails, and a bare "at least one" would return
  // the moment the welcome mail landed, then assert on a set still being filled.
  minCount?: number;
  //: Narrows what counts, so a caller waiting for the ORDER email is not
  // satisfied by the welcome email that arrived first at the same address.
  matching?: (message: MailpitMessage) => boolean;
  //: Names what was awaited in the timeout message. Purely diagnostic.
  description?: string;
}

// Polls until the expected mail arrives, or fails with a message that says what
// was missing and where to look.
//
// Polling rather than a single query is not a robustness nicety — a bare query
// WOULD be flaky. Nothing in the HTTP response the spec just received implies
// the email exists yet: the producer publishes to SQS after its own transaction
// commits, the Lambda is polled by an event-source mapping on its own schedule,
// and SES then relays over SMTP. The email is guaranteed to arrive LATER than
// the API call that caused it, by an amount nobody controls.
export async function waitForEmailTo(
  address: string,
  options: WaitForEmailOptions = {},
): Promise<MailpitMessage[]> {
  const {
    // 60s: comfortably above the observed local delivery time (a few seconds),
    // and bounded on purpose — an unbounded wait on a pipeline that is genuinely
    // down would hang the suite instead of failing it with a diagnosis.
    timeoutMs = 60_000,
    intervalMs = 1_000,
    minCount = 1,
    matching,
    description,
  } = options;

  const deadline = Date.now() + timeoutMs;
  let seen: MailpitMessage[] = [];

  while (Date.now() < deadline) {
    const all = await searchByRecipient(address);
    seen = all;
    const matches = matching ? all.filter(matching) : all;
    if (matches.length >= minCount) return matches;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // Reports what DID arrive, not just what did not. "No email arrived at all"
  // and "three arrived but none was the order confirmation" are different
  // defects — the first points at the queue or the Lambda, the second at
  // dispatch or rendering — and the subject list is what distinguishes them at a
  // glance.
  const what = description ?? `${minCount} email(s)`;
  const arrived = seen.length
    ? `${seen.length} message(s) did arrive for that address: ${seen.map((m) => `"${m.Subject}"`).join(", ")}.`
    : "NOTHING arrived for that address at all.";

  throw new Error(
    `No ${what} appeared in Mailpit for the address this test created within ` +
      `${timeoutMs / 1000}s — ${arrived} ` +
      "Email is produced by the events-pipeline Lambda consuming the shared SQS queue " +
      "(producer → SQS → Lambda → SES → Mailpit), so a miss means one of those hops broke. " +
      "Check the Lambda's logs for the event type, that EVENTS_QUEUE_URL matches the queue " +
      "the event-source mapping reads, and that the mailpit container is up " +
      `(inbox: ${mailpitApiUrl().replace("/api/v1", "")}).`,
  );
}

// Asserts the inbox is reachable before a spec starts asking it questions.
//
// ## Hard failure here, unlike the pipeline's integration test, which SKIPS
//
// That suite runs in `make test-unit` too, where no stack is expected, so a skip
// keeps it honest. This layer is different: the E2E suite ALREADY requires the
// entire stack — global-setup.ts fails outright when Users, Tracking, or the
// gateway is not answering, and Mailpit is a compose service that comes up with
// them. Skipping here would silently downgrade "the pipeline delivers email" to
// "we did not check", which is the exact failure mode this task exists to close.
// A missing Mailpit is a broken environment, and it should say so.
export async function assertMailpitReachable(): Promise<void> {
  const info = `${mailpitApiUrl()}/info`;
  try {
    const res = await fetch(info, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`responded ${res.status}`);
  } catch (err) {
    throw new Error(
      `Mailpit is not answering at ${info} (${(err as Error).message}), so no email assertion ` +
        "could verify anything. It is a docker-compose service like the rest of the stack: " +
        "`docker compose up -d mailpit`, or `make bootstrap` for the whole stack. " +
        "MAILPIT_API_URL is generated into .env.local.infra by `make env-file`.",
    );
  }
}
