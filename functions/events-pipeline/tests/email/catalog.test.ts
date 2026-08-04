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

  // Classification matters: an unknown template is a code/config bug that a
  // retry can never fix, so it must NOT be routed back into batchItemFailures.
  it("throws PermanentError for a template key that is not registered", async () => {
    await expect(renderTemplate("does-not-exist", {})).rejects.toThrow(PermanentError);
  });
});
