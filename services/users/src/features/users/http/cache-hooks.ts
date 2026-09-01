import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CacheGateway } from "#shared/cache/cache-gateway";
import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";
import { setLogContext } from "#shared/logging/log-context";
import { withHttpServerSpan } from "#shared/observability/request-span";

/** 5 minutes — the profile changes rarely, and every write invalidates it. */
export const ME_CACHE_TTL_SECONDS = 300;

/** The route this pair guards. Only this one route is cached in Users. */
export const ME_ROUTE = "/v1/users/me";

// Per-request state, stashed in a WeakMap so `onSend` can see what `preHandler`
// decided. NOT a decorator: a decorator would put the key (which carries
// cognito_sub and user_id) on an object other code can serialize, and this
// state must not outlive the request.
interface CacheState {
  key: string;
  result: "hit" | "miss" | "bypass";
}
const stateFor = new WeakMap<FastifyRequest, CacheState>();

// Only a GET on the cached route participates. The PATCHes registered on the
// same URL must never see a hook, which is why the method is checked too.
function isCacheableRequest(req: FastifyRequest): boolean {
  return req.method === "GET" && (req.routeOptions?.url ?? req.url) === ME_ROUTE;
}

// Resolution itself can throw: `tests/features/users/http/routes.test.ts` builds
// containers that register no `cacheGateway`, and an AwilixResolutionError raised
// inside a hook becomes a request error on a route that has nothing to do with
// caching. Same stance as the `onResponse` hook's `metricsPublisher` guard in
// routes.ts — an observation of a request must never become an error of its own.
//
// Exported because the WRITE path needs the identical guard: the PATCH handlers
// in routes.ts invalidate through this, and a container without a cacheGateway
// must turn a profile update into a 200, not a 500.
export function resolveGateway(req: FastifyRequest): CacheGateway | undefined {
  try {
    return req.diScope.cradle.cacheGateway;
  } catch {
    return undefined;
  }
}

/**
 * Drops the cached profile for one caller, AFTER their write has persisted.
 *
 * `cognitoSub` is the raw x-user-id the read path built its key from and
 * `userId` the resolved id; both halves must match or this deletes nothing.
 * A no-op when either half is missing (an unauthenticated or unresolved
 * caller has no cached entry) or when no gateway is registered.
 */
export async function invalidateMeCache(
  req: FastifyRequest,
  cognitoSub: string | undefined,
  userId: string | undefined,
): Promise<void> {
  const cacheGateway = resolveGateway(req);
  if (cacheGateway === undefined || !cognitoSub || !userId) return;
  await cacheGateway.invalidate(ME_KEY_PREFIX, meCacheKey(cognitoSub, userId));
}

export function registerMeCacheHooks(app: FastifyInstance): void {
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isCacheableRequest(req)) return;

    const cacheGateway = resolveGateway(req);
    if (cacheGateway === undefined || !cacheGateway.enabled) return;

    const { currentActor, currentUser } = req.diScope.cradle;
    if (currentActor === undefined) return;

    // ==== THE KEY CANNOT EXIST BEFORE THIS AWAIT ====
    // `currentActor` is the raw x-user-id, which may be a Cognito sub OR a
    // usr_ id (see CurrentUser's doc comment). The key needs the RESOLVED
    // user_id, and resolve() is the only place it becomes known. resolve()
    // caches its promise, so the handler on a MISS reuses this same lookup —
    // this await costs one query per request, not two.
    const row = await currentUser.resolve();
    if (!row?.id) {
      // A valid token whose user no longer exists. There is no key to build,
      // so this request bypasses the cache silently and the handler answers
      // its 404 — which is never cached anyway.
      return;
    }

    const key = meCacheKey(currentActor, row.id);
    const outcome = await CacheGateway.withCacheSpan("cache.get", () =>
      cacheGateway.get<unknown>(key, ME_KEY_PREFIX),
    );

    const result = outcome.bypass ? "bypass" : outcome.hit ? "hit" : "miss";
    stateFor.set(req, { key, result });
    // Merged into the ACTIVE log-context store, so every later line of this
    // request — including `request completed`, emitted in onResponse by code
    // that knows nothing about caching — carries it.
    setLogContext({ cache_result: result });

    if (outcome.hit) {
      // Short-circuit: `reply.send` from a preHandler means the handler never
      // executes, which is the whole point of the interceptor.
      //
      // The cached value is the SERIALIZED body (see the onSend hook), so it
      // is sent as-is. `type("application/json")` + a pre-serialized payload
      // keeps Fastify's Zod response serializer out of the path — it would
      // otherwise re-validate an already-serialized object.
      return reply
        .header("X-Cache", "HIT")
        // Omitted rather than sent as 0/-1 when Redis reported no usable TTL.
        .headers(
          outcome.ttlRemaining !== undefined
            ? { "X-Cache-TTL": String(outcome.ttlRemaining) }
            : {},
        )
        .type("application/json")
        .send(JSON.stringify(outcome.value));
    }
  });

  app.addHook("onSend", async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const state = stateFor.get(req);
    if (state === undefined) return payload;

    // A HIT already carries its headers from the preHandler; there is nothing
    // to store and nothing to stamp.
    if (state.result === "hit") return payload;

    reply.header("X-Cache", state.result === "bypass" ? "BYPASS" : "MISS");

    // ONLY 200s populate the cache. A 404/500 body cached for five minutes
    // would outlive its cause.
    if (state.result === "miss" && reply.statusCode === 200 && typeof payload === "string") {
      const cacheGateway = resolveGateway(req);
      if (cacheGateway === undefined) return payload;

      // ==== WHY withHttpServerSpan AND NOT trace.getActiveSpan() ====
      // @fastify/otel NULLS `request.opentelemetry().span` inside onSend,
      // which runs BEFORE onResponse (request-span.ts). So the active span
      // here is the hook's own span or nothing at all, and a `cache.set` span
      // parented to it silently vanishes from the waterfall — no error, no
      // warning, just a missing bar. withHttpServerSpan resolves the request's
      // real HTTP SERVER span through RPC metadata on the request's context,
      // which survives the nulling.
      //
      // NOT awaited: onSend sits on the response path, and holding the
      // response open for a Redis round trip would hand back the latency this
      // cache exists to remove. `set` swallows its own failures by contract,
      // so there is no unhandled rejection.
      //
      // `payload` is the ALREADY-SERIALIZED response body — the exact bytes
      // Fastify is about to write. Storing THIS, rather than the domain
      // entity, is what makes a HIT byte-identical to a MISS: serializeUser
      // converts createdAt/updatedAt/deletedAt to ISO strings (routes.ts), and
      // a cached entity would come back through JSON.parse as values the Zod
      // response serializer never saw — a different body for the same user.
      // It is stored PARSED so `get` returns an object via a symmetric
      // JSON.parse; the hit path re-serializes with JSON.stringify, which
      // preserves key order and therefore the byte-identical body.
      void withHttpServerSpan(req, () =>
        CacheGateway.withCacheSpan("cache.set", () =>
          cacheGateway.set(state.key, ME_KEY_PREFIX, JSON.parse(payload), ME_CACHE_TTL_SECONDS),
        ),
      );
    }

    return payload;
  });
}
