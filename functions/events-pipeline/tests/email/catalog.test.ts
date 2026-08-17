import { describe, it, expect, vi } from "vitest";

// #shared/config/env parses process.env at MODULE LOAD (ADR-0014). #email/renderer
// now reaches it through #shared/metrics/cloudwatch-metrics (it publishes the
// permanent-failure counter before throwing on a missing template), so the schema
// must be satisfied here even though this suite never publishes a metric. Mirrors
// tests/handlers/user-created.test.ts.
vi.stubEnv("DOCDB_HOST", "docdb-test");
vi.stubEnv("DOCDB_USERNAME", "root");
vi.stubEnv("DOCDB_PASSWORD", "secret");
vi.stubEnv("SES_FROM_ADDRESS", "noreply@example.com");
// The renderer reads this to build every <img src>, so it lands INSIDE the
// snapshot below. The value must therefore be the one the committed snapshot was
// recorded with, not this file's usual http://assets.test/bucket placeholder.
//
// It was previously inherited by accident: sender.integration.test.ts sets this
// same value with `??=` on the shared process env, so whether the snapshot
// matched depended on FILE EXECUTION ORDER. Stubbing it explicitly here is what
// makes the snapshot deterministic on its own.
vi.stubEnv("ASSETS_BASE_URL", "http://localhost:4566/post-3mrai-local-post-assets");
// No metric may leave this suite: the missing-template case below emits the
// permanent-failure counter, and with this unset it would try to reach a real
// CloudWatch endpoint.
vi.stubEnv("METRICS_ENABLED", "");

import { PermanentError } from "#pipeline/errors";

// Dynamic imports, AFTER the vi.stubEnv calls above: static imports are hoisted
// above all other module code (including vi.stubEnv), so importing the renderer
// at the top of the file would evaluate #shared/config/env before the stubs exist.
const { catalog } = await import("#email/catalog");
const { renderTemplate } = await import("#email/renderer");

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
