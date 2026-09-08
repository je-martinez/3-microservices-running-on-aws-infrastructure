import { render } from "@react-email/render";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { catalog } from "#email/catalog";
import { PermanentError } from "#pipeline/errors";
import { pipelineTracer } from "#shared/observability/tracing";
import { publishEmailMetric } from "#shared/metrics/cloudwatch-metrics";

// Renders a registered template to an HTML string. The renderer reads only the
// catalog, so a new template is an entry there, not a change here.
// CONTRACT: A missing template is PERMANENT, never transient — the key is our
// own code, so a retry fails identically and floods the DLQ.
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

  // CONTRACT: INTERNAL, not CLIENT — React renders in-process, with no socket,
  // and a CLIENT kind draws this as a dependency call in every service map.
  // The span stays: this render DOMINATES the record, costing multiples of the
  // SES round trip it precedes. Named per template so the four are comparable.
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
