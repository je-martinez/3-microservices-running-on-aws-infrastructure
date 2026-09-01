import { expect, type APIResponse } from "@playwright/test";

// The X-Cache contract, asserted from ONE place so a spec can never quietly
// encode a weaker version of it. Full contract:
// docs/shared/conventions/x-cache-response-header.md.
//
// | Value                | Companion        | When                                    |
// |----------------------|------------------|-----------------------------------------|
// | `X-Cache: HIT`       | `X-Cache-TTL: n` | served from Redis, handler skipped      |
// | `X-Cache: MISS`      | none             | not in Redis, handler ran, 200 cached   |
// | `X-Cache: BYPASS`    | none             | Redis unavailable, fell through to DB   |
// | *(no header at all)* | none             | `CACHE_ENABLED=false`                   |
//
// Header lookup is case-insensitive: Playwright's headers() lowercases every
// key, and asserting on "X-Cache" (mixed case) silently reads `undefined`
// regardless of what the service actually sent — a spec that passes while
// proving nothing. Always read the lowercase spelling. This matters concretely
// here: Orders sends `X-Cache` while Users and Tracking send `x-cache`, so any
// spec reading the mixed-case spelling would pass against one service and fail
// against another for a reason that has nothing to do with caching.

function cacheHeader(res: APIResponse): string | undefined {
  return res.headers()["x-cache"];
}

function cacheTtlHeader(res: APIResponse): string | undefined {
  return res.headers()["x-cache-ttl"];
}

/**
 * A cold read: the handler ran and (on a 200) populated the cache.
 *
 * BYPASS is explicitly named in the failure message because it is the ONE
 * outcome that looks like a cache bug and is not: it means Redis was
 * unreachable and the service failed open exactly as designed. Naming it here
 * saves the reader from debugging the interceptor when the actual problem is a
 * stopped container.
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
 * A warm read: served from Redis, the handler never executed.
 *
 * Asserts the TTL header too, and asserts it as a NUMBER in a plausible range
 * rather than merely being present — a header stuck at "0" or carrying a
 * non-numeric string would pass a presence check while telling every client
 * something false.
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
 * The first read of a SHARED, ownerless key (`orders:products:v1`).
 *
 * Such a key may legitimately be warm from an earlier test or an earlier RUN, so
 * asserting MISS would be asserting test-ordering rather than behaviour. What is
 * still assertable — and is the part that catches a real regression — is that the
 * header is PRESENT and is not BYPASS. Without this the natural shortcut is to
 * assert nothing at all on the first read, which would let a stopped Redis pass
 * silently.
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
 * A write response must never carry a cache header — only GETs are cached.
 *
 * Its own helper rather than an inline `toBeUndefined()` because the failure it
 * guards against is subtle: an interceptor registered on the wrong pipeline
 * branch would stamp every response, and a MISS on a PUT looks harmless enough
 * to be scrolled past in a diff.
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
