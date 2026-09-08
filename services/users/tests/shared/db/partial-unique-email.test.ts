import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// CONTRACT: `email` is unique among LIVE rows only — a soft-deleted user keeps their
// real address while a returning one can claim it again. A SCHEMA test on purpose:
// restoring a plain `@unique` compiles, passes every unit test, and breaks nothing
// visible until a gateway E2E gives a returning user a 409, three layers from the
// cause. See [[soft-delete]]
describe("users.email uniqueness", () => {
  const schema = readFileSync(
    resolve(import.meta.dirname, "../../../prisma/schema.prisma"),
    "utf8",
  );

  it("scopes the unique constraint to live rows", () => {
    expect(schema).toContain('@@unique([email], where: raw("deleted_at IS NULL"))');
  });

  it("does not carry a plain @unique on email", () => {
    expect(schema).not.toMatch(/^\s*email\s+String\s+@unique/m);
  });

  it("enables the partialIndexes preview feature", () => {
    expect(schema).toContain('previewFeatures = ["partialIndexes"]');
  });
});
