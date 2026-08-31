const MAILPIT_BASE_URL = process.env.MAILPIT_BASE_URL ?? "http://localhost:8025";

/**
 * Empties Mailpit before the suite — housekeeping, not a pipeline fix.
 *
 * CONTRACT: Call only from globalSetup — mid-run purge deletes concurrent workers' mail.
 * WHY: Email timeouts come from SQS backlog, not inbox eviction.
 * See [[testing]]
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
