import { exec } from "@gatling.io/core";
import { http, status } from "@gatling.io/http";

/**
 * Account deletion: `DELETE /v1/users/me`, shape from `services/users/openapi.yaml`.
 * Loaded for its SHAPE, not throughput: the only synchronous fan-out, so its latency
 * sums Orders, Tracking, Postgres and Cognito `AdminDeleteUser`.
 * CONTRACT: Send no `x-e2e-source`, as everywhere here — nothing cleans up the Cognito
 * users or a failed deletion's orders. Reset with `make clean && make bootstrap`.
 * See [[testing]]
 */

const authHeader = (session: { get: (k: string) => unknown }) =>
  `Bearer ${session.get("token")}`;

/**
 * CONTRACT: A simulation composing these steps must NOT set a protocol-level
 * content-type. This DELETE sends no body and Fastify rejects a declared JSON type
 * with an empty one — `400 FST_ERR_CTP_EMPTY_JSON_BODY`, a 100%-failure run; a
 * per-request `""` sends a literal empty header and 415s instead. Leave it off the
 * protocol: every body-carrying step calls `.asJson()` itself. See [[testing]]
 */

/**
 * CONTRACT: Accept `204` ONLY — do NOT widen to the 502 Users returns when a cascade
 * leg does not confirm. That failure under load is the finding this scenario exists to
 * surface, so accepting it turns the run green for the one outcome worth being red
 * about. Unlike `createOrder`'s 201-or-409, where the 409 is genuine row contention.
 */
export const deleteAccount = exec(
  http("DELETE /v1/users/me")
    .delete("v1/users/me")
    .header("Authorization", authHeader)
    .check(status().is(204)),
);

/**
 * CONTRACT: Do NOT drop this read as redundant to the 204. Under concurrency the real
 * failure is "204 returned and the account is still there" — a cascade reporting
 * success while its Postgres write lost a race. `is(404)` keeps it out of the errors.
 */
export const readProfileAfterDeletion = exec(
  http("GET /v1/users/me (after deletion)")
    .get("v1/users/me")
    .header("Authorization", authHeader)
    .check(status().is(404)),
);

/** A retrying client's second DELETE: `404` is correct and checked as success, while
 * a 204 would mean the endpoint reported deleting something already gone. */
export const deleteAccountAgain = exec(
  http("DELETE /v1/users/me (repeat)")
    .delete("v1/users/me")
    .header("Authorization", authHeader)
    .check(status().is(404)),
);
