import { expect, type APIResponse } from "@playwright/test";

// The X-Cache contract, asserted from ONE place so a spec can never encode a weaker
// version of it. HIT carries X-Cache-TTL; MISS and BYPASS carry none; no header at all
// means CACHE_ENABLED=false.
//
// CONTRACT: Always read the LOWERCASE header spelling. Playwright's headers()
// lowercases every key, so asserting on "X-Cache" reads `undefined` no matter what the
// service sent — a spec that passes while proving nothing. Orders sends `X-Cache` while
// Users and Tracking send `x-cache`, so the mixed-case spelling passes against one
// service and fails against another for a reason unrelated to caching.
// See [[x-cache-response-header]]

function cacheHeader(res: APIResponse): string | undefined {
  return res.headers()["x-cache"];
}

function cacheTtlHeader(res: APIResponse): string | undefined {
  return res.headers()["x-cache-ttl"];
}

/**
 * A cold read: the handler ran and (on a 200) populated the cache. The failure message
 * names BYPASS explicitly — it is the one outcome that looks like a cache bug and is
 * not, meaning Redis was unreachable and the service failed open as designed.
 */
export function expectMiss(res: APIResponse, what: string): void {
  const value = cacheHeader(res);
  expect(
    value,
    `${what}: expected X-Cache: MISS, got ${value ?? "no X-Cache header at all"}. ` +
      "BYPASS means Redis was unreachable (fail-open, not a cache bug) — check the " +
      "floci-valkey container. No header at all means CACHE_ENABLED=false for that service.",
  ).toBe("MISS");
  // A MISS carries NO TTL header — there is nothing cached yet to have a
  // remaining lifetime.
  expect(cacheTtlHeader(res), `${what}: a MISS must not carry X-Cache-TTL`).toBeUndefined();
}

/**
 * A warm read: served from Redis, the handler never executed. The TTL is asserted as a
 * NUMBER in a plausible range, not merely present — a header stuck at "0" or carrying
 * a non-numeric string passes a presence check while telling every client something
 * false.
 */
export function expectHit(res: APIResponse, what: string, maxTtlSeconds: number): void {
  const value = cacheHeader(res);
  expect(
    value,
    `${what}: expected X-Cache: HIT, got ${value ?? "no X-Cache header at all"}. ` +
      "A MISS here means the entry expired or was invalidated between the two reads.",
  ).toBe("HIT");

  const ttl = cacheTtlHeader(res);
  expect(ttl, `${what}: a HIT must carry X-Cache-TTL`).toBeDefined();
  const seconds = Number(ttl);
  expect(Number.isFinite(seconds), `${what}: X-Cache-TTL is not numeric: ${ttl}`).toBe(true);
  expect(seconds, `${what}: X-Cache-TTL must be positive`).toBeGreaterThan(0);
  // Never larger than the key's configured TTL — a value above it means the
  // wrong TTL was written, which a presence-only check would never notice.
  expect(
    seconds,
    `${what}: X-Cache-TTL ${seconds}s exceeds the configured ${maxTtlSeconds}s TTL`,
  ).toBeLessThanOrEqual(maxTtlSeconds);
}

/**
 * CONTRACT: The first read of the SHARED `orders:products:v1` key may legitimately be
 * warm from an earlier RUN, so do NOT assert MISS — but do NOT skip the assertion
 * either. The header must be PRESENT and not BYPASS; asserting nothing on the first
 * read lets a stopped Redis pass silently.
 */
export function expectMissOrHit(res: APIResponse, what: string): void {
  const value = cacheHeader(res);
  expect(
    value,
    `${what}: the shared catalogue key may legitimately be warm, so MISS or HIT are both ` +
      `correct — but the header must be present and must not be BYPASS. Got ` +
      `${value ?? "no X-Cache header at all"}.`,
  ).toMatch(/^(MISS|HIT)$/);
}

/** No cache layer at all — what `CACHE_ENABLED=false` must produce. */
export function expectNoCacheHeaders(res: APIResponse, what: string): void {
  expect(cacheHeader(res), `${what}: X-Cache must be absent when caching is off`).toBeUndefined();
  expect(
    cacheTtlHeader(res),
    `${what}: X-Cache-TTL must be absent when caching is off`,
  ).toBeUndefined();
}

/**
 * A write response must never carry a cache header — only GETs are cached. Its own
 * helper rather than an inline `toBeUndefined()`: an interceptor on the wrong pipeline
 * branch stamps every response, and a MISS on a PUT is harmless-looking enough to be
 * scrolled past in a diff.
 */
export function expectNoCacheHeaderOnWrite(res: APIResponse, what: string): void {
  expect(
    cacheHeader(res),
    `${what}: a write must not carry X-Cache — only GET responses are cached`,
  ).toBeUndefined();
}

/** The raw header, for the rare assertion that needs to inspect it directly. */
export function cacheHeaderOf(res: APIResponse): string | undefined {
  return cacheHeader(res);
}
