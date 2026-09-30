import { Prisma } from "../../generated/prisma/client.ts";

// CONTRACT: STRIPE_TIMEOUT_MS stays BELOW TRANSACTION_TIMEOUT_MS — a Stripe
// call made inside an interactive transaction's row lock must always fail
// before the transaction's own timeout can expire mid-call (Stripe applying
// the change while the local commit rolls back). set-default and reconcile's
// customer.updated handler both hold this same lock across a Stripe call and
// share these constants so the two can never drift out of that ordering.
export const STRIPE_TIMEOUT_MS = 8_000;
export const TRANSACTION_TIMEOUT_MS = 15_000;

/**
 * Locks the user row FOR UPDATE inside an interactive transaction — the same
 * statement set-default and reconcile's customer.updated handler both issue,
 * so a concurrent set-default and a concurrent webhook reconciliation for the
 * same user can never interleave into two isDefault=true rows.
 */
export function lockUserRow(
  tx: { $queryRaw: (query: Prisma.Sql) => Promise<unknown> },
  userId: string,
): Promise<unknown> {
  return tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
}
