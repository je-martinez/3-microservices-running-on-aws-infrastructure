// Reads the pipeline's E2E email records over the events Lambda's Function URL.
//
// ## This is a DIAGNOSTIC channel, not an assertion channel
//
// Specs still wait for the real message in Mailpit and still extract the OTP
// from it. Nothing here replaces that, and nothing here should ever become the
// source of a code a spec logs in with — a suite that reads its OTP from this
// store stops proving that email is delivered at all, which is the one thing
// these specs exist to prove.
//
// What it adds is the answer to the question a bare "nothing arrived in 45s"
// cannot answer: did the pipeline ever RENDER and SEND this email? Those are
// different failures with different fixes — one is a timing ceiling, the other
// is a lost event — and they were indistinguishable before this existed.
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

/**
 * The current run's id, as minted by global-setup.
 *
 * Throws rather than returning a placeholder: a placeholder would query the
 * collection for a run that never existed and return zero rows, which reads
 * identically to "the pipeline sent nothing" — the exact confusion this module
 * exists to remove.
 */
export function currentRunId(): string {
  const runId = process.env.E2E_RUN_ID;
  if (!runId) {
    throw new Error(
      "E2E_RUN_ID is not set. global-setup mints it, so this means a spec ran " +
        "outside the harness or with globalSetup skipped.",
    );
  }
  return runId;
}

function config(): { url: string; token: string } | null {
  const url = process.env.EVENTS_QUERY_URL;
  const token = process.env.E2E_QUERY_TOKEN;
  // Missing config DISABLES diagnostics rather than failing: this channel must
  // never be the reason a test goes red. A stack without the Function URL is a
  // stack where these specs still work, just with less helpful failures.
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Every email the pipeline recorded for this run, newest first.
 *
 * Returns an empty array on ANY failure — unreachable URL, non-2xx, malformed
 * body. Same rule as above: a diagnostic that throws would convert a clear
 * email-timing failure into a confusing connection error and bury the real one.
 */
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
    return [];
  }
}

/**
 * A block to append to a failing email assertion's message.
 *
 * What it can and cannot conclude, stated precisely because an overconfident
 * diagnostic is worse than none:
 *
 *   - RECORDED → the pipeline definitely rendered and sent it. The mail exists,
 *     so the failure is delivery timing. This branch is conclusive.
 *   - NOTHING RECORDED → inconclusive on its own. The store is written after the
 *     send, so a backlog hides the record on the same far side of the budget as
 *     the mail itself. It means "not yet", and only the queue depth separates
 *     "late" from "genuinely lost".
 *
 * Never throws: a failed diagnostic returns a note saying so, because the
 * assertion it is decorating is the thing that matters.
 */
export async function describeRecordedEmails(to: string): Promise<string> {
  let emails: RecordedEmail[];
  try {
    emails = await fetchRecordedEmails({ to });
  } catch (err) {
    return `\n[email-store] Could not query the record store: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  if (emails.length === 0) {
    // "NOT YET", never "never". The store is read at the instant the assertion
    // gives up, and the pipeline records an email only AFTER it sends it — so a
    // backlog puts the record on the far side of the spec's budget too.
    //
    // Measured on a cold stack: a spec timed out at 45s and its OTP was recorded
    // at 2m25s, comfortably real and comfortably late. An earlier version of
    // this message said the pipeline "never rendered one", which is the opposite
    // conclusion and sends the reader hunting a defect that is not there.
    //
    // Distinguishing the two needs the queue depth, which this client cannot
    // read — so it names the check instead of guessing.
    return (
      `\n[email-store] Nothing recorded for ${to} AT THE MOMENT THIS WAS CHECKED. ` +
      `The store is written after the send, so this means the pipeline had not ` +
      `sent it YET — not that the event was lost. A backlog delays the record ` +
      `exactly as it delays the mail. Check the events queue depth: a non-zero ` +
      `depth means late, a zero depth with nothing recorded means genuinely lost.`
    );
  }

  const lines = emails.map(
    (e) =>
      `  - "${e.subject}" (${e.template_key}) recorded at ${e.created_at}, trace ${e.trace_id ?? "n/a"}`,
  );

  return (
    `\n[email-store] The pipeline DID render and send ${emails.length} email(s) for ${to}:\n` +
    lines.join("\n") +
    `\nSo this is a DELIVERY-TIMING failure, not a lost event — the mail exists, it ` +
    `just did not reach Mailpit inside the spec's budget. See ` +
    `docs/lessons/2026-08-29-the-emulator-was-the-ceiling-not-the-code.md.`
  );
}
