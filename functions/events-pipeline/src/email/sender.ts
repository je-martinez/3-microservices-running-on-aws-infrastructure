import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { SpanKind } from "@opentelemetry/api";
import { env } from "#shared/config/env";
import { TransientError } from "#pipeline/errors";
import { appLogger } from "#shared/logging/app-logger";
import { hashEmail } from "#shared/logging/email-hash";
import { publishEmailMetric } from "#shared/metrics/cloudwatch-metrics";
import { withClientSpan } from "#shared/observability/client-span";

/**
 * Hook the E2E email store hangs off. Absent in production, where nothing
 * wires it.
 *
 * CONTRACT: A callback, not an import of the store — importing it would give
 * this transport a Mongo dependency and put the fixture collection in every
 * deployed environment's import graph.
 * See [[testing]]
 */
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
  /** The catalog key that produced `html` — the EmailType metric dimension. */
  templateKey: string;
  /**
   * The plaintext OTP or reset code, when this template carries one.
   *
   * WARNING: Passed to `recordEmail` ONLY — never logged, never on SES
   * metadata, never on the persisted document (#domain/redact-payload strips it).
   */
  code?: string;
  /** Optional E2E recorder. Undefined in production. */
  recordEmail?: RecordEmailFn;
}

// CONTRACT: Lazy, not import-time. Constructing eagerly reads `env` just to
// IMPORT the module, breaking unit tests that only want the type and moving a
// config failure out of the handler's error handling into module evaluation.
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

// SES is transport only — #email/renderer produces the HTML; no SES templates.
// CONTRACT: Every failure here is explicitly TRANSIENT so it retries through
// batchItemFailures. Leaving it unclassified relies on isTransient()'s default
// and lets a refactor silently consume a message — a user's email lost.
export async function sendEmail(params: SendEmailParams): Promise<void> {
  // CONTRACT: The recipient reaches the log only as a non-reversible hash —
  // never plaintext. The envelope context rides along from the ALS store.
  // See [[logging-context]]
  const email_hash = hashEmail(params.to);
  const startedAt = Date.now();

  try {
    // CONTRACT: The span wraps the SEND only. Widening it attributes this
    // process's own logging and metric work to SES. Manual because esbuild
    // inlines the AWS SDK and nothing auto-instruments it. `email_hash` on the
    // attribute, never the recipient — a span attribute reads like a log field.
    // See [[logging-context]]
    await withClientSpan(
      "ses SendEmail",
      SpanKind.CLIENT,
      { "messaging.system": "ses", "rpc.method": "SendEmail", email_hash },
      () => {
        // CONTRACT: Keep this line inside the span and BEFORE the send.
        // OpenObserve's "View logs" filters on `trace_id` AND `span_id` with no
        // fallback, so a span owning no line answers it empty; emitting it
        // before the call keeps it out of the measured round trip. It is also
        // the only line pairing `template_key` with `email_hash` — which email
        // went to whom. Never the plaintext recipient.
        // See [[logging-context]]
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
      // The SDK message is safe (endpoint, status, throttling reason) and never
      // contains the recipient, which lives separately in `params.to`.
      (err) => (err instanceof Error ? err.message : String(err)),
    );
  } catch (err) {
    // CONTRACT: Never interpolate `params.to` into this string — it is
    // persisted on the FAILED document and logged as `reason`, and a plaintext
    // address is the PII the convention forbids.
    // See [[logging-context]]
    const message = err instanceof Error ? err.message : String(err);

    // WHY: Without this line a failed send leaves no trace of its own — the
    // entrypoint only reports the RECORD as failed. `err` is deliberately not
    // passed, so nothing beyond the safe `reason` reaches the log.
    appLogger.error(
      {
        app_event: "email_send_failed",
        reason: message,
        email_hash,
        duration_ms: Date.now() - startedAt,
      },
      "SES send failed",
    );

    // CONTRACT: Only transient failures are counted here. Permanent ones come
    // from the RENDERER (missing template) and are counted there — counting both
    // in one place labels every failure transient and destroys the split.
    // Awaited before the throw; publishEmailMetric never throws, so it cannot
    // mask the TransientError.
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

  // CONTRACT: Record AFTER the send and swallow failures here. Recording first
  // makes the store answer "what was attempted", so a spec reading it during an
  // SES outage sees mail that never left; throwing fails a record whose email
  // already went out and gets it redelivered. WARN, not ERROR — nothing
  // user-facing degraded, but a missing fixture must not read as a missing send.
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
        {
          app_event: "e2e_email_record_failed",
          template_key: params.templateKey,
          email_hash,
          reason: err instanceof Error ? err.message : String(err),
        },
        "could not record the e2e email copy",
      );
    }
  }
}

// Test seam: the module-scope client would otherwise leak configuration across
// test cases in the same file (and across an endpoint change in the
// integration test).
export function resetSesClientForTests(): void {
  client = undefined;
}
