import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Guards the invariant that makes re-registration with a reused email possible:
// `email` is unique among LIVE rows only, so a soft-deleted user keeps their real
// address while a returning one can claim it again.
//
// This is a SCHEMA test rather than a runtime one on purpose. Restoring a plain
// `@unique` would compile, pass every unit test, and break nothing visible until a
// gateway E2E ran against a real Postgres and a returning user got a 409 — by
// which point the cause is three layers away from the symptom. The constraint's
// shape is the thing worth pinning, and the schema file is where it lives.
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
