import { describe, it, expect, beforeAll } from "vitest";

// Layer 2 — a REAL email, through the real transport, asserted from the real
// inbox: userCreatedHandler → render → SES SendEmail (Floci) → SMTP relay →
// Mailpit, read back over Mailpit's HTTP API. Nothing here is mocked.
//
// Why this exists on top of the unit tests: those assert what the handler HANDS
// to sendEmail. They cannot catch a wrong SES `Source`, an unverified sender, a
// relay that drops the HTML body, or an endpoint pointing at nothing — every
// failure mode that lives between our process and the inbox.
//
// Connectivity, UNLIKE the DocumentDB integration suite (which must run inside
// 3mrai_3mrai-network): both Floci (:4566) and Mailpit (:8025) publish their
// ports to the host, so this suite runs from the host with no container gymnastics.
const FLOCI_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const MAILPIT_API = process.env.MAILPIT_API_URL ?? "http://localhost:8025/api/v1";

// Same skip-vs-fail contract as tests/shared/db/events-repository.integration.test.ts.
// Absent stack → SKIP with a self-explanatory message, so Layer 1
// (`make test-unit`, no stack needed) stays green and honest. Set
// EVENTS_PIPELINE_REQUIRE_INTEGRATION=1 where the stack IS expected, and an
// unreachable Mailpit becomes a hard failure instead of a quiet skip that
// proves nothing.
const REQUIRE_INTEGRATION = process.env.EVENTS_PIPELINE_REQUIRE_INTEGRATION === "1";

async function mailpitReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${MAILPIT_API}/info`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const reachable = await mailpitReachable();

if (!reachable && REQUIRE_INTEGRATION) {
  throw new Error(
    `sender integration suite: EVENTS_PIPELINE_REQUIRE_INTEGRATION=1 declares that the local ` +
      `stack must be up, but Mailpit is not answering at ${MAILPIT_API}/info, so nothing would ` +
      `actually be verified. Start it with \`docker compose up -d mailpit floci\`.`,
  );
}

if (!reachable) {
  console.warn(
    `[sender integration] SKIPPED: Mailpit is not answering at ${MAILPIT_API}/info, so there is ` +
      `no inbox to verify against. Run \`docker compose up -d mailpit floci\` and re-run. Both ` +
      `ports are published to the host, so no Docker-network gymnastics are needed (unlike the ` +
      `DocumentDB suite). Set EVENTS_PIPELINE_REQUIRE_INTEGRATION=1 to turn this skip into a ` +
      `hard failure where the stack is expected to be up.`,
  );
}

interface MailpitMessageSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  From: { Address: string };
}

// Polls Mailpit's search API until a message matching `query` appears.
// Polling (not a fixed sleep) because the path is asynchronous end to end:
// SES accepts, then Floci relays over SMTP on its own schedule.
async function pollForMessage(
  query: string,
  timeoutMs = 15000,
  intervalMs = 500,
): Promise<MailpitMessageSummary | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(query)}`);
    const data = (await res.json()) as { messages: MailpitMessageSummary[] };
    if (data.messages.length > 0) return data.messages[0];
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return undefined;
}

describe.skipIf(!reachable)("USER_CREATED email (integration: SES → Floci relay → Mailpit)", () => {
  beforeAll(() => {
    // The env module is Zod-validated at import time and demands the full set
    // (including DOCDB_*), which this suite does not otherwise need. Defaults
    // mirror .env.local.events-pipeline; AWS_ENDPOINT_URL points the SES client
    // at Floci. Set BEFORE the dynamic imports below — a static import would be
    // hoisted above this block and evaluate env too early.
    process.env.AWS_ENDPOINT_URL ??= FLOCI_ENDPOINT;
    process.env.AWS_REGION ??= "us-east-1";
    process.env.AWS_ACCESS_KEY_ID ??= "test";
    process.env.AWS_SECRET_ACCESS_KEY ??= "test";
    process.env.SES_FROM_ADDRESS ??= "no-reply@3mrai.local";
    process.env.DOCDB_HOST ??= "unused-by-this-suite";
    process.env.DOCDB_USERNAME ??= "unused";
    process.env.DOCDB_PASSWORD ??= "unused";
  });

  it("delivers a rendered welcome email whose recipient, sender and body match the event", async () => {
    // The REAL handler, not sendEmail directly: this asserts the whole
    // USER_CREATED path a queued event takes — payload validation, template
    // selection, render, and transport.
    const { userCreatedHandler } = await import("#handlers/user-created");

    // Unique per run so a re-run never asserts against the previous run's mail,
    // and so this suite is safe to run against a shared/persistent Mailpit.
    const marker = `it-${Date.now()}`;
    const recipient = `${marker}@example.com`;

    await userCreatedHandler({
      event_id: `evt_${marker}`,
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_integration",
      order_id: null,
      payload: { fullName: "Ada Lovelace", email: recipient },
    });

    // Search by RECIPIENT, not subject: the subject is fixed copy shared by
    // every welcome email, so it cannot distinguish this run's message.
    const summary = await pollForMessage(`to:"${recipient}"`);

    expect(summary, `no email for ${recipient} arrived in Mailpit within 15s`).toBeDefined();
    expect(summary!.To.map((t) => t.Address)).toContain(recipient);
    expect(summary!.From.Address).toBe(process.env.SES_FROM_ADDRESS);
    expect(summary!.Subject).toBe("Welcome to 3MRAI");

    // Fetch the full message: the summary carries no body, and the body is the
    // part that proves the react-email render actually survived the transport
    // rather than an empty/placeholder email being delivered.
    const full = (await (await fetch(`${MAILPIT_API}/message/${summary!.ID}`)).json()) as {
      HTML: string;
    };
    expect(full.HTML).toContain("Ada Lovelace");
    expect(full.HTML).toContain(recipient);
    expect(full.HTML).toContain("3MRAI");
  }, 30000);

  it("does not deliver anything for an invalid payload (PermanentError before transport)", async () => {
    const { userCreatedHandler } = await import("#handlers/user-created");
    const { PermanentError } = await import("#pipeline/errors");

    const marker = `it-invalid-${Date.now()}`;
    const recipient = `${marker}@example.com`;

    // fullName empty → fails validation, so nothing must be sent even though
    // the address itself is perfectly deliverable.
    await expect(
      userCreatedHandler({
        event_id: `evt_${marker}`,
        type: "USER_CREATED",
        source: "users",
        user_id: "usr_integration",
        order_id: null,
        payload: { fullName: "", email: recipient },
      }),
    ).rejects.toThrow(PermanentError);

    // Give the relay a window in which a wrongly-sent email COULD have landed,
    // so this assertion can actually fail rather than just racing ahead of it.
    await new Promise((r) => setTimeout(r, 2000));

    const res = await fetch(
      `${MAILPIT_API}/search?query=${encodeURIComponent(`to:"${recipient}"`)}`,
    );
    const data = (await res.json()) as { messages: MailpitMessageSummary[] };
    expect(data.messages).toHaveLength(0);
  }, 30000);
});
