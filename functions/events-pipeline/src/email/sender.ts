import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { SpanKind } from "@opentelemetry/api";
import { env } from "#shared/config/env";
import { TransientError } from "#pipeline/errors";
import { appLogger } from "#shared/logging/app-logger";
import { hashEmail } from "#shared/logging/email-hash";
import { publishEmailMetric } from "#shared/metrics/cloudwatch-metrics";
import { withClientSpan } from "#shared/observability/client-span";

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
    // Manual CLIENT span around the transport ONLY. The AWS SDK is inlined into
    // the esbuild bundle, so auto-instrumentation cannot patch it (see
    // #shared/observability/client-span) and this send would otherwise be an
    // unexplained gap inside `process_record` — which is precisely where the
    // latency lives when SES is slow.
    //
    // Scoped to the send, not to the whole function: the outcome logging and
    // metric publishing below are this process's own work, and folding them in
    // would attribute their time to SES. The one line that IS inside (see
    // below) precedes the call rather than wrapping it, and is there to make
    // the span answerable by "View logs" — its rationale is at the call site.
    //
    // `email_hash`, never the recipient — the same rule the log line obeys, for
    // the same reason. A span attribute is as readable as a log field.
    await withClientSpan(
      "ses SendEmail",
      SpanKind.CLIENT,
      { "messaging.system": "ses", "rpc.method": "SendEmail", email_hash },
      () => {
        // The ONE line that belongs to this span rather than to the record.
        //
        // WHY IT EXISTS: OpenObserve's "View logs" on a span filters by
        // `trace_id` AND `span_id`, with no fallback to the trace — so a span
        // with no log line of its OWN answers it with an empty result, however
        // many lines the surrounding trace has. `ses SendEmail` is the only
        // span we own that was in that state.
        //
        // WHY IT DOES NOT CORRUPT THE MEASUREMENT: it is emitted BEFORE the
        // send is issued, not around it. pino's default destination is a
        // synchronous stdout write of a few hundred bytes — microseconds,
        // ahead of a network round trip to SES — and, being before the call,
        // it cannot sit between the request and its response. The span still
        // brackets the same SES call it always did; that is why the
        // succeeded/failed lines below stay OUTSIDE, where they describe the
        // RECORD's work and remain findable from `process_record`.
        //
        // WHY THIS CONTENT: it is the only place `template_key` and
        // `email_hash` appear together — "which email went to whom" — which
        // no other line in this service answers. `email_hash`, never the
        // plaintext recipient, exactly as the span attribute above.
        appLogger.info(
          { app_event: "ses_send_requested", template_key: params.templateKey, email_hash },
          "requesting SES send",
        );

        return getClient().send(
          new SendEmailCommand({
            Source: env.SES_FROM_ADDRESS,
            Destination: { ToAddresses: [params.to] },
            Message: {
              Subject: { Data: params.subject },
              Body: { Html: { Data: params.html } },
            },
          }),
        );
      },
      // The SDK's message is safe here (endpoint, status, throttling reason) —
      // established in the catch below, and it never contains the recipient,
      // which this function holds separately in `params.to` and never
      // interpolates.
      (err) => (err instanceof Error ? err.message : String(err)),
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
