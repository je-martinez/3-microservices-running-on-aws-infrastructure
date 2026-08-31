const MAILPIT_BASE_URL = process.env.MAILPIT_BASE_URL ?? "http://localhost:8025";

/**
 * Empties Mailpit so a suite run starts against a clean inbox.
 *
 * ## Why this exists
 *
 * Mailpit holds a bounded buffer and evicts the OLDEST message once it is full.
 * At the container's default cap of 500 the inbox had reached exactly that,
 * having accumulated hundreds of messages across runs, and `/api/v1/info`
 * reported `SMTPAccepted: 511 / Messages: 500 / MessagesDeleted: 11`.
 *
 * ## What this does NOT fix — read this before blaming the inbox
 *
 * That eviction was real but was NOT why the 11 email specs failed. Raising the
 * cap to 5000 and purging here left the inbox demonstrably healthy — 213 held,
 * zero capacity evictions — and the same specs still failed. The eleven evicted
 * messages matching the eleven failures was a COINCIDENCE, and it is a
 * seductive one: do not let a matching count stand in for a causal chain.
 *
 * The real cause is pipeline THROUGHPUT, measured directly:
 *
 *   - idle:            OTP email arrives in 6.2s
 *   - during a suite:  the same probe gets NOTHING in 90s (specs allow 45s)
 *   - queue mid-suite: 72 waiting + 10 in flight
 *   - drain rate:      ~50 events/min (~0.8-1.75/s), one Lambda container at a
 *                      time, batch_size 10
 *   - one suite:       808 events published by registrations alone vs 494
 *                      consumed
 *
 * The suite publishes faster than the pipeline drains, the backlog grows for
 * the whole run, and an event published mid-suite waits behind ~72 others —
 * past the 45s budget. The emails are NOT lost and NOT evicted: they arrive
 * late. The queue is back to 0 once the run ends, which is why every isolated
 * probe and every email-only run (30/30 green) succeeds.
 *
 * global-setup's warnOnEventsQueueBacklog() already described this exact
 * failure mode for a PRE-EXISTING backlog. What it cannot see is the suite
 * building that backlog itself, from empty, as it runs.
 *
 * So this purge is housekeeping, not a fix: it keeps the inbox from growing
 * without bound and keeps failures legible (328 stale "Welcome to 3MRAI"
 * messages turn manual inspection into archaeology). Specs match on recipient,
 * so stale mail never caused false PASSES.
 *
 * ## Why ONLY in global setup
 *
 * Playwright runs specs across parallel workers against ONE Mailpit. A purge is
 * destructive and cannot tell whose mail it deletes, so calling it mid-run would
 * delete a concurrent worker's email and manufacture the very failure this
 * removes. globalSetup runs once, before any worker starts, and is the only safe
 * point. Never call this from a spec, a fixture, or a per-worker hook.
 *
 * ## Why a failure here is NOT fatal
 *
 * Unlike restockCatalogue(), which gates on stock the specs need to exist, a
 * failed purge only leaves the inbox as it was. With the cap raised, that is
 * survivable — so this warns and continues rather than blocking a suite over
 * housekeeping. An unreachable Mailpit still fails loudly, in the specs that
 * actually depend on it, via assertMailpitReachable().
 */
export async function purgeMailpit(): Promise<void> {
  try {
    const res = await fetch(`${MAILPIT_BASE_URL}/api/v1/messages`, { method: "DELETE" });

    if (!res.ok) {
      console.warn(
        `[global-setup] Could not purge Mailpit: HTTP ${res.status} from ` +
          `DELETE ${MAILPIT_BASE_URL}/api/v1/messages. Continuing with the inbox as-is — ` +
          "email specs still pass against a dirty inbox (they match on recipient), " +
          "but stale mail makes manual inspection harder.",
      );
    }
  } catch (error) {
    console.warn(
      `[global-setup] Could not reach Mailpit to purge it at ${MAILPIT_BASE_URL}: ` +
        `${error instanceof Error ? error.message : String(error)}. Continuing — ` +
        "specs that need Mailpit assert its reachability themselves.",
    );
  }
}
