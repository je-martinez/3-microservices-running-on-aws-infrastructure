import { render } from "@react-email/render";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { catalog } from "#email/catalog";
import { PermanentError } from "#pipeline/errors";
import { pipelineTracer } from "#shared/observability/tracing";
import { publishEmailMetric } from "#shared/metrics/cloudwatch-metrics";

// Renders a registered template to an HTML string. The renderer knows nothing
// about individual templates — it only reads the catalog — so Tasks 11 and 12
// add entries without touching this file.
//
// A missing template is PERMANENT, not transient: the key comes from our own
// code, so a retry re-runs the same lookup and fails identically. Classifying
// it transient would push the record into batchItemFailures and flood the DLQ.
export async function renderTemplate(templateKey: string, props: unknown): Promise<string> {
  // Own-property lookup: a plain `catalog[key]` resolves inherited members like
  // "constructor" or "toString", and we would then try to call one as a
  // component. Same reasoning as the handler lookup in pipeline/process-record.
  const entry = Object.prototype.hasOwnProperty.call(catalog, templateKey)
    ? catalog[templateKey]
    : undefined;

  if (!entry) {
    // A missing template is PERMANENT: the record will not be retried and the
    // email is lost. This counter is the only signal that a customer never got
    // their mail, which is why it is emitted HERE and split from the transient
    // SES failures counted in #email/sender.
    await publishEmailMetric("emails_failed_total", templateKey, {
      FailureKind: "permanent",
    });
    // The key is ours (a template name), never user input — safe to log/persist.
    throw new PermanentError(`missing template: ${templateKey}`);
  }

  // INTERNAL, not CLIENT: this is React rendering an HTML string in-process —
  // no socket, no remote peer. `withClientSpan` would be the wrong helper and a
  // CLIENT kind would make this look like a dependency call in every service map.
  //
  // It is instrumented because it turned out to DOMINATE the record. Once the
  // DocumentDB transitions got their own spans, `process_record` still showed a
  // ~167ms hole between `handler_dispatched` and `ses SendEmail` — measured on
  // trace 049808878a72285defdd27deb58850e8. That hole is this call: rendering the
  // order receipt costs multiples of the SES round trip it precedes, which is the
  // opposite of what the waterfall implied while the render was invisible and SES
  // was the only visible cost in the handler.
  //
  // Named by template so the four templates are comparable to each other rather
  // than averaged into one figure.
  return pipelineTracer.startActiveSpan(
    `email render ${templateKey}`,
    { kind: SpanKind.INTERNAL, attributes: { "email.template": templateKey } },
    async (span) => {
      try {
        // The one place the catalog's erased prop type is crossed. Callers are
        // responsible for validating props before they get here — the handlers do
        // it with Zod, and the preview/test path uses the entry's own sampleProps.
        const html = await render(entry.component(props));
        // Size is the input to the SES payload limit, and the number that explains
        // a slow render — a receipt with 40 line items is not the same work as a
        // 3-line welcome. The HTML is never put ON the span: it embeds the
        // customer's name, address and email.
        span.setAttribute("email.html_bytes", Buffer.byteLength(html, "utf8"));
        span.setStatus({ code: SpanStatusCode.OK });
        return html;
      } catch (err) {
        // The error CLASS only, per the same PII rule the DocumentDB spans follow:
        // a React render error can quote the props it choked on, and those props
        // are the customer's receipt.
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.name : "render_failed",
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
