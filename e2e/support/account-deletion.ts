import { expect, type APIRequestContext } from "@playwright/test";

/**
 * `DELETE /v1/users/me` expecting `204`, with a bounded retry on `502` only.
 *
 * CONTRACT: Do NOT widen this to accept `502` as success. Users maps every cascade-leg
 * failure to it, and under a full parallel suite a one-off `502` was observed on an
 * account with no downstream rows while the same test passed in isolation. Each attempt
 * still demands `204` and exhausting them fails — retrying the one status Users
 * documents as "caller may retry" is the production client's contract, not a weakened
 * assertion. Narrower than the load test's `deleteAccount`, where a 502 is the finding.
 * See [[testing]]
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
