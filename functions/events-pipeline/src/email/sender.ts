import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { env } from "#shared/config/env";
import { TransientError } from "#pipeline/errors";
import { appLogger } from "#shared/logging/app-logger";
import { hashEmail } from "#shared/logging/email-hash";
import { publishEmailMetric } from "#shared/metrics/cloudwatch-metrics";

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  /** The catalog key that produced `html` — the EmailType metric dimension. */
  templateKey: string;
}

// Module-scope singleton, created LAZILY — same shape and same reasons as
// #shared/db/client's Mongo client: reused across warm invocations, but not
// constructed at import time. Constructing it eagerly would read `env` (and so
// require the full env) merely to IMPORT this module, which breaks unit tests
// that only want the type, and would move a config failure out of the handler's
// error handling and into module evaluation.
let client: SESClient | undefined;

function getClient(): SESClient {
  if (!client) {
    client = new SESClient({
      region: env.AWS_REGION,
      // Set only when present: locally it points at Floci (:4566); in AWS the
      // variable is absent and the SDK resolves the real regional endpoint.
      ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
    });
  }
  return client;
}

// SES is transport only — the HTML is already rendered by #email/renderer (see
// the milestone design spec's "Rendering decision": no SES native templates).
//
// EVERY failure here is classified TRANSIENT: SES being unreachable, throttled
// or timing out is exactly the case that must be retried through
// batchItemFailures. The alternative (letting it fall through unclassified)
// would still be transient by isTransient()'s safe default, but making it
// explicit is what keeps a future refactor from turning a send failure into a
// silently-consumed message — i.e. a user's email lost with no trace.
export async function sendEmail(params: SendEmailParams): Promise<void> {
  // The recipient reaches the log only as a NON-REVERSIBLE hash. Plaintext
  // email is never logged (docs/shared/conventions/logging-context.md); the
  // hash is the cross-service key that still lets an operator trace every
  // failed send to one recipient. The envelope context (event_id, type, ...)
  // rides along automatically from the ALS store the handler opened.
  const email_hash = hashEmail(params.to);
  const startedAt = Date.now();

  try {
    await getClient().send(
      new SendEmailCommand({
        Source: env.SES_FROM_ADDRESS,
        Destination: { ToAddresses: [params.to] },
        Message: {
          Subject: { Data: params.subject },
          Body: { Html: { Data: params.html } },
        },
      }),
    );
  } catch (err) {
    // The SDK's message is safe to surface (endpoint, status, throttling
    // reason) but the RECIPIENT is not — never interpolate params.to here: this
    // string is persisted on the FAILED document and logged as `reason`, and a
    // plaintext email address is precisely the PII the logging convention
    // forbids. The recipient is already recoverable from the event's payload.
    const message = err instanceof Error ? err.message : String(err);

    // Logged HERE, not only at the handler level: without this line a failed
    // send leaves no trace of its own — the entrypoint reports the record as
    // failed, but nothing says the email was the thing that failed, nor to
    // whom. `reason` carries the SDK message (already established as safe
    // above); `err` is deliberately not passed, so nothing else of the error
    // reaches the record.
    appLogger.error(
      {
        app_event: "email_send_failed",
        reason: message,
        email_hash,
        duration_ms: Date.now() - startedAt,
      },
      "SES send failed",
    );

    // Every SES failure is transient — this catch only ever sees SES errors, and
    // the throw below is unconditionally TransientError. A permanent failure
    // comes from the RENDERER (a missing template), never from here, which is
    // why the permanent counter lives there: counting both in one place would
    // label every failure transient and destroy the split the metric exists for.
    //
    // Emitted BEFORE the throw, and awaited: publishEmailMetric never throws, so
    // it cannot mask or replace the TransientError.
    await publishEmailMetric("emails_failed_total", params.templateKey, {
      FailureKind: "transient",
    });

    throw new TransientError(`SES send failed: ${message}`);
  }

  // No SUCCESS severity by design (it is not an OTel level): success is INFO
  // plus app_event=*_succeeded.
  appLogger.info(
    {
      app_event: "email_send_succeeded",
      email_hash,
      duration_ms: Date.now() - startedAt,
    },
    "sent email",
  );

  await publishEmailMetric("emails_sent_total", params.templateKey);
}

// Test seam: the module-scope client would otherwise leak configuration across
// test cases in the same file (and across an endpoint change in the
// integration test).
export function resetSesClientForTests(): void {
  client = undefined;
}
