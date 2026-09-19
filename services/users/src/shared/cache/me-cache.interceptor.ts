import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { from, Observable, of, switchMap, tap } from "rxjs";
import type { CurrentUser } from "#shared/auth/current-user";
import { CacheGateway } from "#shared/cache/cache-gateway";
import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";
import { setLogContext } from "#shared/logging/log-context";
import { withHttpServerSpan } from "#shared/observability/request-span";

/** 5 minutes — the profile changes rarely, and every write invalidates it. */
export const ME_CACHE_TTL_SECONDS = 300;

type RequestWithCurrentUser = FastifyRequest & { currentUser?: CurrentUser };

type CacheDecision =
  | { kind: "skip" }
  | { kind: "hit"; value: unknown }
  | { kind: "miss" | "bypass"; key: string };

/**
 * Drops the cached profile for one caller, AFTER their write has persisted.
 *
 * CONTRACT: Both key halves must match the read path exactly — `cognitoSub` is the
 * raw x-user-id the interceptor built its key from, `userId` the resolved id — or
 * this deletes nothing. A no-op when either is missing.
 * See [[users-service-design]]
 */
export async function invalidateMeCache(
  cacheGateway: CacheGateway | undefined,
  cognitoSub: string | undefined,
  userId: string | undefined,
): Promise<void> {
  if (cacheGateway === undefined || !cognitoSub || !userId) return;
  await cacheGateway.invalidate(ME_KEY_PREFIX, meCacheKey(cognitoSub, userId));
}

// CONTRACT: Apply ONLY to GET /v1/users/me. The interceptor short-circuits a HIT
// before the handler runs; a MISS/BYPASS stamps X-Cache on the way out and stores
// only 200 bodies. Keying requires CurrentUser.resolve() — the raw x-user-id alone
// is not enough. See [[x-cache-response-header]]
@Injectable()
export class MeCacheInterceptor implements NestInterceptor {
  constructor(private readonly cacheGateway: CacheGateway) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithCurrentUser>();
    const reply = http.getResponse<FastifyReply>();

    return from(this.lookup(req, reply)).pipe(
      switchMap((decision) => {
        if (decision.kind === "hit") return of(decision.value);
        if (decision.kind === "skip") return next.handle();

        return next.handle().pipe(
          tap({
            next: (body) => this.stampAndStore(req, reply, decision, body),
          }),
        );
      }),
    );
  }

  private async lookup(
    req: RequestWithCurrentUser,
    reply: FastifyReply,
  ): Promise<CacheDecision> {
    if (!this.cacheGateway.enabled) return { kind: "skip" };

    const currentUser = req.currentUser;
    if (currentUser === undefined) return { kind: "skip" };

    // CONTRACT: The key cannot be built before this await. `identity` is the raw
    // x-user-id (Cognito sub OR usr_ id); the key needs the RESOLVED user_id.
    // resolve() caches its promise, so a MISS reuses this lookup in the handler.
    const row = await currentUser.resolve();
    if (!row?.id) {
      // Valid token whose user no longer exists: no key, so the handler answers
      // its 404, which is never cached.
      return { kind: "skip" };
    }

    const key = meCacheKey(currentUser.identity, row.id);
    const outcome = await CacheGateway.withCacheSpan("cache.get", () =>
      this.cacheGateway.get<unknown>(key, ME_KEY_PREFIX),
    );

    const result = outcome.bypass ? "bypass" : outcome.hit ? "hit" : "miss";
    setLogContext({ cache_result: result });

    if (outcome.hit) {
      reply.header("X-Cache", "HIT");
      if (outcome.ttlRemaining !== undefined) {
        reply.header("X-Cache-TTL", String(outcome.ttlRemaining));
      }
      return { kind: "hit", value: outcome.value };
    }

    return { kind: result === "bypass" ? "bypass" : "miss", key };
  }

  private stampAndStore(
    req: RequestWithCurrentUser,
    reply: FastifyReply,
    decision: Extract<CacheDecision, { kind: "miss" | "bypass" }>,
    body: unknown,
  ): void {
    reply.header("X-Cache", decision.kind === "bypass" ? "BYPASS" : "MISS");

    // ONLY 200s populate the cache. A 404/500 body cached for five minutes
    // would outlive its cause. A MISS carries NO X-Cache-TTL.
    if (decision.kind !== "miss" || reply.statusCode !== 200 || body === undefined) {
      return;
    }

    // CONTRACT: Use withHttpServerSpan, NOT trace.getActiveSpan(). @fastify/otel
    // can null the ambient span on the response path, so a cache.set span parented
    // to it vanishes from the waterfall with no error. Do NOT await — holding the
    // response for a Redis round trip hands back the latency this cache removes.
    // Store the ALREADY-SERIALIZED handler body (ISO dates), not a domain entity.
    // See [[logging-context]]
    void withHttpServerSpan(req, () =>
      CacheGateway.withCacheSpan("cache.set", () =>
        this.cacheGateway.set(decision.key, ME_KEY_PREFIX, body, ME_CACHE_TTL_SECONDS),
      ),
    );
  }
}
