import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// CONTRACT: R7 forbids anything that connects to the shared local dev database
// (migrate dev/reset/db push). This asserts the generated migration.sql directly
// instead, so "existing users rows are unaffected" is checked without a DB.
const MIGRATION_SQL_PATH = path.join(
  import.meta.dirname,
  "../../../prisma/migrations/20260922200941_add_stripe_customer_and_payment_methods/migration.sql",
);

const sql = readFileSync(MIGRATION_SQL_PATH, "utf-8");

describe("add_stripe_customer_and_payment_methods migration", () => {
  it("adds the two users columns as nullable (existing rows unaffected)", () => {
    expect(sql).toMatch(/ALTER TABLE "users" ADD COLUMN\s+"stripe_customer_data" JSONB,/);
    expect(sql).toMatch(/ADD COLUMN\s+"stripe_customer_id" TEXT;/);
    // Neither new users column carries NOT NULL — a nullable column added to an
    // existing table leaves every current row valid with no backfill.
    expect(sql).not.toMatch(/"stripe_customer_id" TEXT NOT NULL/);
    expect(sql).not.toMatch(/"stripe_customer_data" JSONB NOT NULL/);
  });

  it("adds a unique index on users.stripe_customer_id", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "users_stripe_customer_id_key" ON "users"\("stripe_customer_id"\);/,
    );
  });

  it("creates the stripe_payment_methods table with a unique stripe_payment_method_id", () => {
    expect(sql).toMatch(/CREATE TABLE "stripe_payment_methods" \(/);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "stripe_payment_methods_stripe_payment_method_id_key" ON "stripe_payment_methods"\("stripe_payment_method_id"\);/,
    );
  });

  it("makes `type` NOT NULL and the card fields nullable (spec D16: dynamic payment methods)", () => {
    expect(sql).toMatch(/"type" TEXT NOT NULL,/);
    expect(sql).toMatch(/"brand" TEXT,/);
    expect(sql).toMatch(/"last4" TEXT,/);
    expect(sql).toMatch(/"exp_month" INTEGER,/);
    expect(sql).toMatch(/"exp_year" INTEGER,/);
    expect(sql).toMatch(/"funding" TEXT,/);
    expect(sql).not.toMatch(/"brand" TEXT NOT NULL/);
    expect(sql).not.toMatch(/"last4" TEXT NOT NULL/);
    expect(sql).not.toMatch(/"exp_month" INTEGER NOT NULL/);
    expect(sql).not.toMatch(/"exp_year" INTEGER NOT NULL/);
    expect(sql).not.toMatch(/"funding" TEXT NOT NULL/);
  });

  it("adds the userId foreign key and the (userId, deletedAt) index", () => {
    expect(sql).toMatch(
      /ALTER TABLE "stripe_payment_methods" ADD CONSTRAINT "stripe_payment_methods_user_id_fkey" FOREIGN KEY \("user_id"\) REFERENCES "users"\("id"\)/,
    );
    expect(sql).toMatch(
      /CREATE INDEX "stripe_payment_methods_user_id_deleted_at_idx" ON "stripe_payment_methods"\("user_id", "deleted_at"\);/,
    );
  });

  it("touches no unrelated table", () => {
    const tableMentions = [...sql.matchAll(/(?:TABLE|INDEX ON|CONSTRAINT "[a-z_]+" FOREIGN KEY[^)]+\) REFERENCES) "([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    expect(new Set(tableMentions)).toEqual(new Set(["stripe_payment_methods", "users"]));
  });
});
