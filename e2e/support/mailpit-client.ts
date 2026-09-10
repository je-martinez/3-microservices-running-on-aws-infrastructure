// Reads the local Mailpit inbox — the last hop of the events-pipeline's email path,
// and the only place that proves an email was actually DELIVERED. Every layer below
// stops short of it: a broken producer, a queue the Lambda is not subscribed to, or a
// dispatch that silently drops an event type all leave those suites green and the
// user's inbox empty. No test-specific logic here — the specs decide what to assert.

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
// CONTRACT: Always pass the caller's own address — never default or hardcode one, and
// never match on a prefix. Mailpit ACCUMULATES (a long-lived container global-teardown
// deliberately does not clear, already holding ~150 messages), so a looser query
// asserts against a PREVIOUS run's email and passes while the pipeline is broken.
// Two properties keep it safe: chance-factory mints `e2e+<randomUUID()>@example.com`
// per run outside the seeded Chance instance, and Mailpit's `to:` is an EXACT match —
// against 148 messages all beginning `e2e+`, `to:e2e@example.com` returned 0.
// See [[testing]]
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

// CONTRACT: Poll; do NOT replace this with a single query. Nothing in the HTTP
// response a spec just received implies the email exists yet — the producer publishes
// to SQS after its transaction commits, the Lambda is polled on its own schedule, and
// SES then relays over SMTP. The mail always lands LATER than the call that caused it,
// by an amount nobody controls. See [[testing]]
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

//: One message as `GET /message/{ID}` renders it — the FULL shape the /search summary
// is not: that carries only `Snippet`, a flattened preview, while this carries the real
// `Text` and `HTML` bodies. Only the fields a spec reads are declared (Mailpit returns
// many more), same rule as MailpitMessage above.
export interface MailpitFullMessage {
  ID: string;
  Subject: string;
  From: { Name: string; Address: string };
  To: { Name: string; Address: string }[];
  //: The plain-text alternative part. NOTE it is not raw prose — react-email's
  // text rendering decorates headings with runs of `*`, so match content with a
  // tolerant pattern rather than an exact-line equality.
  Text: string;
  HTML: string;
}

// Fetches ONE message in full, by id.
//
// CONTRACT: Do NOT assert body content off a `searchByRecipient` result. That is
// Mailpit's SUMMARY shape whose only body field is `Snippet`, a flattened TRUNCATED
// preview — a code near the end of a longer email, or wrapped in markup, is cut or
// mangled, and the failure reads as "the pipeline did not send it" when the mail was
// delivered perfectly. The flow is: wait for the message → fetch it here → extract.
// See [[email-templates]]
export async function getMessage(id: string): Promise<MailpitFullMessage> {
  const res = await fetch(`${mailpitApiUrl()}/message/${encodeURIComponent(id)}`);

  if (!res.ok) {
    throw new Error(
      `Mailpit returned ${res.status} for message ${id} at ${mailpitApiUrl()}/message/${id}. ` +
        "The id comes from a prior search, so a 404 here means the inbox was cleared " +
        "between the search and this fetch.",
    );
  }

  return (await res.json()) as MailpitFullMessage;
}

// CONTRACT: Fail hard here — do NOT skip when Mailpit is unreachable. The E2E suite
// already requires the whole stack (global-setup fails outright without Users,
// Tracking or the gateway) and Mailpit comes up with it, so a skip silently downgrades
// "the pipeline delivers email" to "we did not check". See [[testing]]
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
