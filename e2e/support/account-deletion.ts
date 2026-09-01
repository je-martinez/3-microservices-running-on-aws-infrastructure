import { expect, type APIRequestContext } from "@playwright/test";

/**
 * `DELETE /v1/users/me` expecting `204`, with a bounded retry on `502` only.
 *
 * Users maps every cascade-leg failure to `502` (`CascadeFailedError`). Under a
 * full parallel suite the Orders and Tracking containers accept many concurrent
 * internal `DELETE …/by-user` calls at once; a one-off `502` on an account with
 * no downstream rows was observed in cycle 3 of the clean+bootstrap+e2e matrix
 * (account-deletion.spec.ts:133) while the same test passed in isolation and in
 * the other eight cycles.
 *
 * This is NOT widened to accept `502` as success — each attempt still demands
 * `204`, and exhausting the attempts fails the test. Retrying only the status
 * Users documents as "a cascade leg did not confirm, account intact, caller may
 * retry" is the same contract the production client would use, not a weakened
 * assertion.
 *
 * Deliberately narrower than load-test `deleteAccount`, which accepts `204` ONLY
 * because a `502` there is the finding the simulation exists to surface.
 */
export async function deleteMeExpect204(
  users: APIRequestContext,
  userId: string,
  attempts = 3,
): Promise<void> {
  let lastStatus: number | undefined;
  let lastBody = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await users.delete("/v1/users/me", { headers: { "x-user-id": userId } });
    lastStatus = res.status();
    lastBody = await res.text();
    if (lastStatus === 204) return;
    if (lastStatus === 502 && attempt < attempts) continue;
    break;
  }

  expect(
    lastStatus,
    `DELETE /v1/users/me failed after ${attempts} attempt(s): ${lastStatus} ${lastBody}`,
  ).toBe(204);
}
