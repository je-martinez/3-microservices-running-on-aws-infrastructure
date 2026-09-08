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

// CONTRACT: Keep this guarded. Resolution throws for a container that registers no
// `cacheGateway`, and an AwilixResolutionError inside a hook becomes a request error
// on a route with nothing to do with caching. The WRITE path needs the identical
// guard, which is why this is exported: a profile update must be a 200, not a 500.
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
 * CONTRACT: Both key halves must match the read path exactly — `cognitoSub` is the
 * raw x-user-id it built its key from, `userId` the resolved id — or this deletes
 * nothing. A no-op when either is missing or no gateway is registered.
 * See [[users-service-design]]
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

    // CONTRACT: The key cannot be built before this await. `currentActor` is the raw
    // x-user-id, which may be a Cognito sub OR a usr_ id; the key needs the RESOLVED
    // user_id. resolve() caches its promise, so a MISS reuses this lookup.
    const row = await currentUser.resolve();
    if (!row?.id) {
      // A valid token whose user no longer exists: no key to build, so this bypasses
      // the cache and the handler answers its 404, which is never cached anyway.
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
      // Short-circuit: `reply.send` from a preHandler skips the handler entirely.
      // CONTRACT: Send the cached SERIALIZED body as-is with `type("application/json")`
      // — that keeps Fastify's Zod response serializer out of the path, which would
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

      // CONTRACT: Use withHttpServerSpan, NOT trace.getActiveSpan(). @fastify/otel
      // nulls `request.opentelemetry().span` inside onSend, so a `cache.set` span
      // parented to the ambient span vanishes from the waterfall with no error at all.
      // See [[logging-context]]

      // CONTRACT: Do NOT await. onSend is on the response path, and holding it open
      // for a Redis round trip hands back the latency this cache exists to remove.
      // `set` swallows its own failures, so nothing goes unhandled.

      // CONTRACT: Store `payload`, the ALREADY-SERIALIZED body, not the domain entity.
      // That is what makes a HIT byte-identical to a MISS — serializeUser converts the
      // dates to ISO strings, and a cached entity returns values the Zod response
      // serializer never saw. Stored parsed so the hit path's JSON.stringify preserves
      // key order.
      void withHttpServerSpan(req, () =>
        CacheGateway.withCacheSpan("cache.set", () =>
          cacheGateway.set(state.key, ME_KEY_PREFIX, JSON.parse(payload), ME_CACHE_TTL_SECONDS),
        ),
      );
    }

    return payload;
  });
}
