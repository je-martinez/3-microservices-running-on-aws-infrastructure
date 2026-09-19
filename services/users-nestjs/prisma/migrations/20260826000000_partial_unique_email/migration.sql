-- Scope the email uniqueness to LIVE rows only.
--
-- A soft-deleted user keeps their real email (no tombstoning — preserving the
-- historical value is the requirement), so the previous unconditional unique
-- index permanently burned the address and made re-registration impossible.
-- Postgres scopes the constraint instead, which is what frees the address while
-- leaving the old row untouched.
--
-- The index NAME is kept identical to the one Prisma generated for the old
-- `@unique`, because that is what Prisma derives from `@@unique([email])` too.

-- DropIndex
DROP INDEX "users_email_key";

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email") WHERE (deleted_at IS NULL);
