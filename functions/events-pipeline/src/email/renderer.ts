import { render } from "@react-email/render";
import { catalog } from "#email/catalog";
import { PermanentError } from "#pipeline/errors";

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
    // The key is ours (a template name), never user input — safe to log/persist.
    throw new PermanentError(`missing template: ${templateKey}`);
  }

  // The one place the catalog's erased prop type is crossed. Callers are
  // responsible for validating props before they get here — the handlers do it
  // with Zod, and the preview/test path uses the entry's own sampleProps.
  return render(entry.component(props));
}
