import { describe, it, expect } from "vitest";
import { catalog } from "#email/catalog";
import { renderTemplate } from "#email/renderer";
import { PermanentError } from "#pipeline/errors";

describe("email catalog", () => {
  it("registers user-created with sample props", () => {
    expect(catalog["user-created"]).toBeDefined();
    expect(catalog["user-created"].sampleProps).toHaveProperty("fullName");
  });

  // The catalog's contract for the preview server and for Tasks 11/12: a NEW
  // entry must be renderable purely from its own sampleProps, with no
  // per-template special-casing anywhere. This loops over whatever is
  // registered, so the assertion grows with the catalog instead of being
  // re-written per template.
  it("every catalog entry renders without throwing and produces an HTML document", async () => {
    const keys = Object.keys(catalog);
    expect(keys.length).toBeGreaterThan(0);

    for (const [key, entry] of Object.entries(catalog)) {
      const html = await renderTemplate(key, entry.sampleProps);
      expect(html, `entry "${key}" did not render an <html> document`).toContain("<html");
      expect(html, `entry "${key}" rendered an empty document`).not.toHaveLength(0);
    }
  });

  it("user-created renders the recipient's full name (snapshot)", async () => {
    const html = await renderTemplate("user-created", {
      fullName: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(html).toContain("Ada Lovelace");
    expect(html).toMatchSnapshot();
  });

  // The gateway E2E signs in with a real OTP, which it can only do by scraping
  // the code out of the delivered message body — `e2e/tests/gateway/otp-flow.spec.ts`
  // strips the tags and takes the first `\b\d{6}\b`. This reproduces that exact
  // extraction here, in the fast suite.
  //
  // Without it the property has NO permanent guard: the template renders the
  // code twice on purpose (one contiguous sentence for machines, six boxed
  // digits for humans), the duplication reads as redundant, and deleting the
  // sentence breaks nothing visible — the emails still look right and the E2E
  // suite silently loses its ability to log in. The six boxes alone can never
  // satisfy the regex, since markup sits between every digit.
  it("renders the OTP code as contiguous text the gateway E2E can extract", async () => {
    const html = await renderTemplate("auth-otp", catalog["auth-otp"].sampleProps);

    const body = html.replace(/<[^>]+>/g, " ");
    const match = body.match(/\b(\d{6})\b/);

    expect(match?.[1], "no six-digit run survived tag-stripping — the E2E cannot sign in").toBe(
      "042817",
    );
  });

  // Classification matters: an unknown template is a code/config bug that a
  // retry can never fix, so it must NOT be routed back into batchItemFailures.
  it("throws PermanentError for a template key that is not registered", async () => {
    await expect(renderTemplate("does-not-exist", {})).rejects.toThrow(PermanentError);
  });
});
