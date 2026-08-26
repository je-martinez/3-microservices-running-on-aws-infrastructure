import { exec } from "@gatling.io/core";
import { http, status } from "@gatling.io/http";

/**
 * Account deletion: `DELETE /v1/users/me`.
 *
 * Shape taken from `services/users/openapi.yaml` (`operationId: deleteMe`): no
 * body, no query, identity from the JWT alone, `204` on success. Composes onto a
 * session that already ran the Users login — like every other scenario here, it
 * does not register its own user.
 *
 * ## Why this one request is worth loading at all
 *
 * It is not a hot path — a person deletes their account once, if ever, so its
 * THROUGHPUT is uninteresting by construction. What makes it worth measuring is
 * its SHAPE: it is the only synchronous fan-out in the system. One inbound
 * request blocks on, in order,
 *
 *   1. `DELETE /v1/orders/by-user`   — .NET + MySQL, four statements, three tables
 *   2. `DELETE /v1/trackings/by-user` — FastAPI + MySQL, cascading through an FK
 *   3. its own Postgres soft-delete
 *   4. Cognito `AdminDeleteUser`      — an external IdP call
 *
 * Nothing else in 3MRAI holds a user-facing request open across two services AND
 * an identity provider. So its latency is the SUM of four dependencies rather
 * than one, and the tail is where that compounds: a p95 that is fine for each leg
 * individually can still add up to a request that times out. That is a question
 * only sustained concurrency can answer, and it is the question this scenario is
 * for.
 *
 * ## No `x-e2e-source`, and here it matters more than usual
 *
 * Same rule as every simulation in this directory — but note the consequence is
 * different for a DELETE. The rows this creates are soft-deleted BY THE FEATURE
 * ITSELF, which is a genuine exercise of the production write path rather than a
 * cleanup. What is not cleaned up is the Cognito users and the pre-deletion
 * orders of any virtual user whose deletion failed. Reset with
 * `make clean && make bootstrap`.
 */

const authHeader = (session: { get: (k: string) => unknown }) =>
  `Bearer ${session.get("token")}`;

/**
 * ## This scenario's simulation must NOT set a protocol-level content-type
 *
 * Recorded here as well as in `accountDeletion.gatling.ts`, because these steps
 * are exported and a future simulation that composes them would reintroduce the
 * bug silently.
 *
 * `DELETE /v1/users/me` sends NO BODY. Users runs Fastify, whose content-type
 * parser rejects a declared JSON content-type with an empty body:
 *
 *     400 FST_ERR_CTP_EMPTY_JSON_BODY
 *     "Body cannot be empty when content-type is set to 'application/json'"
 *
 * Both measured against the running stack (2026-08-26), each a 100%-failure run:
 * with `.contentTypeHeader("application/json")` on the protocol the deletes 400;
 * overriding it per-request with `""` sends a literal empty header and they 415
 * instead. The SDK has no per-request header removal, so the only fix is to leave
 * it off the protocol — which is free, since every body-carrying step calls
 * `.asJson()` and sets it itself.
 *
 * Not a general rule about DELETEs: Orders (.NET) answers 204 to the same
 * header-without-body request, which is why `cart.ts`'s `deleteCart` never hit
 * this. The strictness is Fastify's.
 */

/**
 * Delete the authenticated caller's account.
 *
 * `204` ONLY. Deliberately NOT widened to accept 502, which is the status Users
 * returns when a cascade leg does not confirm: under load, a cascade leg failing
 * is precisely the finding this scenario exists to surface, so tolerating it
 * would make the run green for the one outcome worth being red about.
 *
 * This differs from `createOrder`'s 201-or-409, and the difference is principled
 * rather than inconsistent: a 409 there is the system working AS DESIGNED
 * (row-level contention on stock, which real concurrent buyers genuinely cause).
 * A 502 here is the system failing — there is no correct reason for one user's
 * deletion to be refused because another user is also deleting.
 */
export const deleteAccount = exec(
  http("DELETE /v1/users/me")
    .delete("v1/users/me")
    .header("Authorization", authHeader)
    .check(status().is(204)),
);

/**
 * Read the profile back after deletion, expecting `404`.
 *
 * Checked as `is(404)`, so it counts as a SUCCESSFUL request and does not
 * pollute the error rate — the same treatment the deliberate 401s in
 * `users.ts` get.
 *
 * Worth a request rather than trusting the 204: under concurrency the
 * interesting failure is not "the delete returned an error", it is "the delete
 * returned 204 and the account is still there" — a cascade that reported success
 * while its Postgres write lost a race. Only a read after the fact can see that,
 * and it costs one cheap GET per virtual user.
 */
export const readProfileAfterDeletion = exec(
  http("GET /v1/users/me (after deletion)")
    .get("v1/users/me")
    .header("Authorization", authHeader)
    .check(status().is(404)),
);

/**
 * A second `DELETE /v1/users/me` with the same token, expecting `404`.
 *
 * Models the client that retries — a flaky connection, an impatient double-tap.
 * Checked as `is(404)`, so it is a successful request here: 404 is the correct
 * answer, and a 204 would mean the endpoint reported deleting something that was
 * already gone.
 */
export const deleteAccountAgain = exec(
  http("DELETE /v1/users/me (repeat)")
    .delete("v1/users/me")
    .header("Authorization", authHeader)
    .check(status().is(404)),
);
