// Reads the pipeline's E2E email records over the events Lambda's Function URL.
//
// CONTRACT: This is a DIAGNOSTIC channel, never an assertion channel. Specs must still
// wait for the real Mailpit message and extract the OTP from it — a suite that reads
// its code from this store stops proving email is delivered at all, the one thing
// these specs exist to prove. What it adds is the answer a bare "nothing arrived in
// 45s" cannot give: did the pipeline ever RENDER and SEND it? A timing ceiling and a
// lost event are different failures with different fixes. See [[testing]]

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
 * CONTRACT: Throw; do NOT return a placeholder. It would query a run that never existed
 * and return zero rows, reading identically to "the pipeline sent nothing".
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
  // CONTRACT: Missing config DISABLES diagnostics — this channel must never be the
  // reason a test goes red. Without the Function URL the specs still work, just with
  // less helpful failures.
  if (!url || !token) return null;
  return { url, token };
}

/**
 * Every email the pipeline recorded for this run, newest first.
 * CONTRACT: Return `[]` on ANY failure — unreachable URL, non-2xx, malformed body. A
 * diagnostic that throws buries a clear email-timing failure under a connection error.
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
 * A block to append to a failing email assertion's message. Never throws.
 * CONTRACT: RECORDED is conclusive — rendered and sent, so the failure is delivery
 * timing. NOTHING RECORDED means "not yet", NOT "never": the store is written after
 * the send, so a backlog hides the record on the same far side of the budget as the
 * mail. Only the queue depth separates late from lost.
 * See [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]]
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
    // CONTRACT: Word this as "NOT YET", never "never". The store is written after the
    // send, so a backlog puts the record on the far side of the spec's budget too — a
    // spec once timed out at 45s while its OTP was recorded at 2m25s. Concluding "the
    // pipeline never rendered one" sends the reader hunting a defect that is not there.
    // Separating late from lost needs the queue depth, which this client cannot read,
    // so it names the check instead of guessing.
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
