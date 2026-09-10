import Fastify, { type FastifyInstance } from "fastify";
import { fastifyAwilixPlugin, type Cradle } from "@fastify/awilix";
import { asValue, asFunction, Lifetime, type AwilixContainer } from "awilix";
import { diContainer, registerSingletons, registerServices } from "#shared/di/awilix-container";
import { actorContext } from "#shared/audit/actor-context";
import { AuthError } from "#shared/auth/auth-errors";
import { RecordNotFoundError } from "#shared/db/db-errors";
import { CascadeError } from "#shared/http/cascade-client";
import { buildLoggerOptions } from "#shared/logging/logger";
import { logContext } from "#shared/logging/log-context";
import { REQUEST_ID_HEADER, resolveRequestId } from "#shared/logging/request-id";
import { RUN_ID_HEADER, resolveRunId } from "#shared/logging/run-id";
import { withHttpServerSpan } from "#shared/observability/request-span";
import { env } from "#shared/config/env";
import { isPublicRoute } from "#shared/http/public-routes";
import { CurrentUser } from "#shared/auth/current-user";
import type { Db } from "#shared/db/prisma";
import { cognitoWebhookPayloadSchema } from "../webhooks/cognito-payload.ts";
import { verifyWebhookSecret } from "../webhooks/verify-secret.ts";
import { NoMatchingUserError } from "../webhooks/capture-cognito-identity.ts";
import { registerMeCacheHooks, invalidateMeCache } from "./cache-hooks.ts";
import type { User } from "../domain/user.ts";
import fastifySwagger from "@fastify/swagger";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod/v4";

// WHY: `fastify-type-provider-zod` emits an `*Input` twin for every registered schema
// and the suffix is not configurable. Our schemas are response-only, so those twins are
// orphans that only bloat the spec in Apidog. Pruning on the OpenAPI object (before
// @fastify/swagger serializes it) survives YAML reformatting; a referenced `*Input`
// keeps its `$ref` and survives.
function pruneOrphanComponents(openapiObject: ReturnType<typeof jsonSchemaTransformObject>) {
  const schemas = (openapiObject as { components?: { schemas?: Record<string, unknown> } })
    .components?.schemas;
  if (!schemas) return openapiObject;
  const doc = JSON.stringify(openapiObject);
  for (const name of Object.keys(schemas)) {
    const ref = `"#/components/schemas/${name}"`;
    // Each component stamps its own `$id` with this string once; a real
    // reference (`$ref`) is any additional occurrence. `<= 1` ⇒ orphan.
    if (doc.split(ref).length - 1 <= 1) delete schemas[name];
  }
  return openapiObject;
}

const transformObjectPruned: typeof jsonSchemaTransformObject = (input) =>
  pruneOrphanComponents(jsonSchemaTransformObject(input));

/**
 * The liveness probe's route. Only its 2xx responses are exempt from the request
 * log — see the `onResponse` hook and [[health-check-logging]].
 */
const HEALTH_ROUTE = "/v1/health";
// Side-effect import: `schemas.ts` registers `UserSchema`/`AuthTokensSchema`/
// `ErrorSchema` in `z.globalRegistry` at module-eval time (see that file's
// bottom `z.globalRegistry.add(...)` calls), which is how they surface under
// `components/schemas` in the generated OpenAPI doc.
import "./schemas.ts";
import {
  RegisterInputSchema, RegisterPasswordlessInputSchema, LoginInputSchema, UpdateProfileInputSchema,
  RefreshInputSchema, RefreshedTokensSchema,
  OtpStartInputSchema, OtpStartResponseSchema, OtpVerifyInputSchema,
  ForgotPasswordInputSchema, ConfirmPasswordResetInputSchema, ChangePasswordInputSchema,
  PasswordResetAcceptedSchema, PasswordResetConfirmedSchema,
  UserSchema, AuthTokensSchema, ErrorSchema,
  HealthResponseSchema, E2ECleanupResponseSchema,
  UserIdHeader, WebhookSecretHeader, AuthorizationHeader,
} from "./schemas.ts";

// `User` (the domain shape returned by commands/queries) carries real `Date`
// fields; `UserSchema` documents the wire shape as ISO strings (see
// schemas.ts). Convert at the HTTP boundary — Zod's serializer strictly
// rejects a `Date` against `z.string()`, it does not coerce.
export function serializeUser(user: User) {
  return {
    ...user,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    deletedAt: user.deletedAt ? user.deletedAt.toISOString() : null,
  };
}

// Extracts the raw token from an `Authorization: Bearer <token>` header, or null
// when the header is absent or not a Bearer one. The scheme match is
// case-insensitive because HTTP auth schemes are, and a client sending `bearer`
// holds a perfectly valid token.
// WARNING: The return value is a credential — pass it on, never log it.
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer[ ]+(.+)$/i.exec(header?.trim() ?? "");
  return match?.[1]?.trim() || null;
}

// Builds the Fastify app wired to an Awilix container. Commands/queries resolve
// per-request from `request.diScope`; defaults to the shared `diContainer` singleton,
// and tests can pass an isolated container pre-loaded with mocked services.
// `opts.logStream` lets tests capture the schema log output instead of stdout.
export function buildApp(
  container: AwilixContainer<Cradle> = diContainer,
  opts?: { logStream?: { write: (s: string) => void } },
): FastifyInstance {
  if (container === diContainer) {
    registerSingletons();
    registerServices();
  }

  const loggerOptions = buildLoggerOptions({
    serviceName: "users",
    environment: env.DEPLOYMENT_ENVIRONMENT,
  });

  const app = Fastify({
    logger: opts?.logStream
      ? ({ ...loggerOptions, stream: opts.logStream } as never)
      : loggerOptions,
    // CONTRACT: Keep this true — the onResponse hook below replaces Fastify's own
    // request log rather than adding to it. Re-enabling it emits TWO "request
    // completed" lines per request, doubling every request-rate figure and leaving
    // half the rows with no `http_route` field to filter on.
    // See [[logging-context]]
    disableRequestLogging: true,
  });

  // Emits one schema-aligned log per response (OTel-style HTTP semantic
  // conventions), replacing Fastify's default per-request start/end logs.
  app.addHook("onResponse", (req, reply, done) => {
    const route = req.routeOptions?.url ?? req.url;

    // CONTRACT: Exempt the liveness probe by STATUS, never by route. A succeeding
    // probe logs nothing (the container being up already says it); a FAILING one
    // must still log. Suppressing the route instead hides the failures, and not
    // exempting it at all drowns real work — 353 of 368 lines in an hour.
    // See [[health-check-logging]]
    const isHealthySoak =
      route === HEALTH_ROUTE &&
      reply.statusCode >= 200 &&
      reply.statusCode < 300;

    if (!isHealthySoak) {
      // CONTRACT: Log with the HTTP SERVER span active, not the ambient hook span.
      // `@fastify/otel` wraps every hook in its own span, so without this the line
      // is stamped with the onResponse hook's `span_id` and OpenObserve's "View
      // logs" on the request span returns NOTHING.
      // See [[logging-context]]
      withHttpServerSpan(req, () => {
        req.log.info(
          {
            http_request_method: req.method,
            http_route: route,
            http_response_status_code: reply.statusCode,
            duration_ms: reply.elapsedTime,
            // CONTRACT: Do NOT add `trace_id: req.id`. The real OTel trace_id/span_id
            // come from logger.ts's formatter, and an explicit field beats the ambient
            // one — Fastify's local request counter would overwrite the real id on the
            // most useful line and break the logs↔traces join.
            // See [[logging-context]]
          },
          "request completed",
        );
      });
    }

    // Error-rate metric. ONLY 4xx/5xx are counted: a metric per 2xx would be a
    // request-rate metric, which the log line above already provides, and it
    // would multiply the published series for no added signal.
    const status = reply.statusCode;
    if (status >= 400) {
      // CONTRACT: Keep this guarded and unawaited. Resolution can throw (a test
      // container with no `metricsPublisher`), which Fastify would surface as a
      // request error on an already-sent response; awaiting would hold the
      // connection open for a PutMetricData round trip. `publish()` never rejects.
      try {
        void req.diScope.cradle.metricsPublisher.publish("http_errors_total", 1, {
          Service: "users",
          StatusClass: status >= 500 ? "5xx" : "4xx",
        });
      } catch {
        // Intentionally silent — see above.
      }
    }

    done();
  });

  // The response cache for GET /v1/users/me: a preHandler/onSend pair, the
  // FIRST hooks of either kind in this service (until now it had exactly two
  // global hooks, onRequest and onResponse). See cache-hooks.ts for the two
  // traps that live in them — the key needing CurrentUser.resolve(), and
  // @fastify/otel nulling the span inside onSend.
  registerMeCacheHooks(app);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Maps domain `AuthError`s (see shared/auth/auth-errors.ts) to their HTTP status.
  // Everything else (Zod 400s, unexpected 500s) is re-thrown so Fastify's default
  // error handler keeps producing its own body.
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AuthError) {
      return reply.code(error.statusCode).send({ error: error.code });
    }
    // The cross-cutting `update` handler (see shared/db/prisma-extensions.ts)
    // translates a soft-deleted/absent update target (Prisma P2025) into this
    // typed error; map it to the same 404 `{ error: "not_found" }` contract the
    // /users/me routes already return.
    if (error instanceof RecordNotFoundError) {
      return reply.code(error.statusCode).send({ error: error.code });
    }
    // A cascade leg did not confirm, so the account was deliberately NOT deleted.
    // 502 rather than 500: the failure is DOWNSTREAM, and the correct client
    // action is to retry — both internal routes are idempotent, so retrying is
    // safe and completes whichever leg is still outstanding.
    if (error instanceof CascadeError) {
      return reply.code(502).send({ error: "cascade_failed" });
    }
    throw error;
  });

  app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Users Service API",
        version: "1.0.0",
        description:
          "HTTP API for the 3MRAI Users microservice (Fastify + Aurora Postgres). " +
          "Identity is enforced at the API Gateway authorizer, which forwards the " +
          "Cognito subject as the x-user-id header.",
      },
      servers: [{ url: "http://localhost:3000", description: "Local (docker compose / Floci)" }],
      tags: [
        { name: "health", description: "Liveness" },
        { name: "users", description: "Registration, auth and profile" },
        { name: "webhooks", description: "Inbound Cognito trigger (shared-secret guarded)" },
        { name: "e2e", description: "Test-only routes (E2E_TESTING_ENABLED)" },
      ],
    },
    transform: jsonSchemaTransform,
    transformObject: transformObjectPruned,
  });

  const r = app.withTypeProvider<ZodTypeProvider>();

  // Registers `app.diContainer` (resolves the singletons/services above) and
  // `request.diScope` for per-request registrations (e.g. `currentActor` below).
  app.register(fastifyAwilixPlugin, {
    disposeOnClose: true,
    disposeOnResponse: true,
    container,
  });

  // CONTRACT: Call `done()` from INSIDE the `actorContext.run(...)` callback. Fastify
  // continues the hook/handler chain off that call, so a `done()` outside the callback
  // leaves the rest of the request without the store and the Prisma audit extension
  // writes the actor as null. Also enforces auth: a missing x-user-id on a non-public
  // route (shared/http/public-routes.ts) short-circuits with 401.
  // See [[audit-fields]]
  app.addHook("onRequest", (req, reply, done) => {
    const actor = req.headers["x-user-id"] as string | undefined;
    const routePath = req.routeOptions?.url ?? req.url;

    // CONTRACT: Attach the request id BEFORE the auth guard below, which returns
    // instead of calling `done()`. That branch never reaches the `logContext.run`
    // wrapper, so without `enterWith` here every 401 ships with no correlation id.
    // See [[2026-08-15-request-id-correlation-design]]
    const request_id = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    // CONTRACT: `run_id` is E2E-only and caller-controlled — without
    // E2E_TESTING_ENABLED the header must behave as if never sent. Omit it when
    // absent, never blank: an empty run_id attributes an events-pipeline email
    // fixture to a run that does not exist.
    // See [[logging-context]]
    const run_id = resolveRunId(req.headers[RUN_ID_HEADER], container.cradle.env.E2E_TESTING_ENABLED);
    logContext.enterWith({ request_id, ...(run_id ? { run_id } : {}) });

    if (actor === undefined && !isPublicRoute(req.method, routePath)) {
      reply.code(401).send({ error: "unauthenticated" });
      return; // do NOT call done() — the request is already finished
    }

    req.diScope.register({
      currentActor: asValue(actor),
      currentUser: asFunction(
        ({ db }: { db: Db }) => new CurrentUser({ db, identity: actor as string }),
        { lifetime: Lifetime.SCOPED },
      ),
    });
    // Seed the per-request log context so every line carries the caller's identity
    // without any call site passing it; commands enrich it later via `setLogContext`.
    // Nested inside actorContext.run so both stores wrap the same continuation.
    actorContext.run({ actor }, () => {
      logContext.run(
        {
          request_id,
          ...(actor === undefined ? {} : { cognito_sub: actor }),
          ...(run_id ? { run_id } : {}),
        },
        done,
      );
    });
  });

  // CONTRACT: Keep the `onRequest` actor-context hook and the `fastifyAwilixPlugin`
  // registration ABOVE this `app.after()`. Routes inside the callback inherit only
  // what is already registered on this root context, so moving either below silently
  // drops `currentActor`/`diScope` from every route. `after()` also defers
  // registration until @fastify/swagger's `onRoute` hook exists, or routes miss the spec.
  app.after(() => {
    r.get("/v1/health", {
      schema: {
        tags: ["health"], operationId: "getHealth", summary: "Liveness probe",
        response: { 200: HealthResponseSchema },
      },
    }, async () => ({ status: "ok" as const }));

    r.post("/v1/users/register", {
      schema: {
        tags: ["users"], operationId: "registerUser", summary: "Register a new user",
        body: RegisterInputSchema,
        response: { 201: UserSchema, 409: ErrorSchema },
      },
    }, async (req, reply) => {
      const body = req.body; // typed from RegisterInputSchema
      const headerFlag = req.headers["x-e2e-source"] === "true";
      const { env, registerUserCommand } = req.diScope.cradle;
      const e2eSource = headerFlag && env.E2E_TESTING_ENABLED;
      const user = await registerUserCommand.execute({ ...body, e2eSource });
      return reply.code(201).send(serializeUser(user));
    });

    // Same `x-e2e-source` tag logic as /v1/users/register above — without it
    // these users carry no "E2E Source" tag and the global teardown (which
    // deletes by tag) never cleans them, so they leak.
    r.post("/v1/users/register/passwordless", {
      schema: {
        tags: ["users"], operationId: "registerPasswordlessUser",
        summary: "Register a new passwordless user (OTP-only login)",
        body: RegisterPasswordlessInputSchema,
        response: { 201: UserSchema, 409: ErrorSchema },
      },
    }, async (req, reply) => {
      const body = req.body; // typed from RegisterPasswordlessInputSchema
      const headerFlag = req.headers["x-e2e-source"] === "true";
      const { env, registerPasswordlessCommand } = req.diScope.cradle;
      const e2eSource = headerFlag && env.E2E_TESTING_ENABLED;
      const user = await registerPasswordlessCommand.execute({ ...body, e2eSource });
      return reply.code(201).send(serializeUser(user));
    });

    r.post("/v1/users/login", {
      schema: {
        tags: ["users"], operationId: "loginUser", summary: "Log in and obtain tokens",
        body: LoginInputSchema,
        response: { 200: AuthTokensSchema, 401: ErrorSchema },
      },
    }, async (req, reply) => {
      const { loginUserCommand } = req.diScope.cradle;
      const tokens = await loginUserCommand.execute(req.body);
      return reply.send(tokens);
    });

    r.post("/v1/users/refresh", {
      schema: {
        tags: ["users"], operationId: "refreshToken",
        summary: "Exchange a refresh token for new id/access tokens",
        body: RefreshInputSchema,
        response: { 200: RefreshedTokensSchema, 401: ErrorSchema },
      },
    }, async (req, reply) => {
      const { refreshTokenCommand } = req.diScope.cradle;
      const tokens = await refreshTokenCommand.execute(req.body);
      return reply.send(tokens);
    });

    // CONTRACT: Read the token from the Authorization header, NOT a body field — a
    // body field could name a DIFFERENT session than the one that authenticated the
    // request. Do NOT add this route to `shared/http/public-routes.ts`: that absence
    // is what makes the onRequest hook 401 a caller with no identity.
    // See [[users-service-design]]
    r.post("/v1/users/logout", {
      schema: {
        tags: ["users"], operationId: "logoutUser",
        summary: "Revoke the caller's Cognito session",
        description:
          "Globally signs the caller out, invalidating the id, access and refresh tokens " +
          "Cognito issued to them. Idempotent: an already-revoked or expired token also " +
          "answers 204, because the session being gone is the requested outcome.",
        headers: AuthorizationHeader,
        response: { 204: z.null(), 401: ErrorSchema },
      },
    }, async (req, reply) => {
      const { signOutCommand } = req.diScope.cradle;
      const accessToken = bearerToken(req.headers.authorization);
      // A caller past the onRequest guard holds an x-user-id but may still have sent
      // no parseable Bearer token (a direct internal call, or a gateway misconfigured
      // to drop the header). There is no token to revoke, so this cannot be a 204.
      if (!accessToken) return reply.code(401).send({ error: "invalid_credentials" });
      await signOutCommand.execute({ accessToken });
      return reply.code(204).send(null);
    });

    // OTP login, step 1 of 2. Cognito CUSTOM_AUTH: the challenge Lambda mints
    // the code and hands it to the events pipeline for emailing — it is never
    // in this response, and never in a log line.
    r.post("/v1/users/otp/start", {
      schema: {
        tags: ["users"], operationId: "startOtpChallenge",
        summary: "Start an OTP login challenge (password or passwordless users)",
        body: OtpStartInputSchema,
        response: { 200: OtpStartResponseSchema, 401: ErrorSchema },
      },
    }, async (req, reply) => {
      const { startOtpChallengeCommand } = req.diScope.cradle;
      const result = await startOtpChallengeCommand.execute(req.body);
      return reply.send(result);
    });

    // OTP login, step 2 of 2. Returns the SAME AuthTokensSchema as
    // /v1/users/login, so the gateway/JWT contract is unchanged regardless of
    // which path issued the tokens.
    r.post("/v1/users/otp/verify", {
      schema: {
        tags: ["users"], operationId: "verifyOtpChallenge",
        summary: "Verify an OTP code and obtain tokens",
        body: OtpVerifyInputSchema,
        response: { 200: AuthTokensSchema, 401: ErrorSchema },
      },
    }, async (req, reply) => {
      const { verifyOtpChallengeCommand } = req.diScope.cradle;
      const tokens = await verifyOtpChallengeCommand.execute(req.body);
      return reply.send(tokens);
    });

    // CONTRACT: ALWAYS 202 with a fixed body, even for an unknown email — a 404
    // here is a user-enumeration oracle, not a missing error case. The reset is
    // self-owned: this service mints, hashes and verifies the code, because
    // Cognito's ForgotPassword never returns its code to the caller.
    // See [[users-service-design]]
    r.post("/v1/users/password/forgot", {
      schema: {
        tags: ["users"], operationId: "forgotPassword",
        summary: "Request a password reset code by email",
        description:
          "Always answers 202 with the same body, whether or not the email belongs to an " +
          "account — the response deliberately does not reveal which.",
        body: ForgotPasswordInputSchema,
        response: { 202: PasswordResetAcceptedSchema },
      },
    }, async (req, reply) => {
      const { forgotPasswordCommand } = req.diScope.cradle;
      await forgotPasswordCommand.execute(req.body);
      return reply.code(202).send({ status: "accepted" as const });
    });

    // Password reset, step 2 of 2. A wrong code, an expired code, a
    // already-consumed code and an unknown email all return the SAME 401
    // `invalid_reset_code` — anything else would undo step 1's non-enumeration.
    r.post("/v1/users/password/confirm", {
      schema: {
        tags: ["users"], operationId: "confirmPasswordReset",
        summary: "Confirm a password reset with the emailed code",
        body: ConfirmPasswordResetInputSchema,
        response: { 200: PasswordResetConfirmedSchema, 401: ErrorSchema },
      },
    }, async (req, reply) => {
      const { confirmPasswordResetCommand } = req.diScope.cradle;
      await confirmPasswordResetCommand.execute(req.body);
      return reply.send({ status: "password_updated" as const });
    });

    r.get("/v1/users/me", {
      schema: {
        tags: ["users"], operationId: "getMe", summary: "Get the current user's profile",
        headers: UserIdHeader,
        response: { 200: UserSchema, 404: ErrorSchema },
      },
    }, async (req, reply) => {
      const { userQueryService, currentActor, currentUser } = req.diScope.cradle;
      const me = currentActor ? await userQueryService.getMe(currentUser) : null;
      return me ? reply.send(serializeUser(me)) : reply.code(404).send({ error: "not_found" });
    });

    r.patch("/v1/users/me", {
      schema: {
        tags: ["users"], operationId: "updateMe", summary: "Update the current user's profile",
        headers: UserIdHeader,
        body: UpdateProfileInputSchema,
        response: { 200: UserSchema, 404: ErrorSchema },
      },
    }, async (req, reply) => {
      const { updateProfileCommand, currentUser, currentActor } = req.diScope.cradle;
      const updated = await updateProfileCommand.execute(currentUser, req.body);
      if (!updated) return reply.code(404).send({ error: "not_found" });

      // CONTRACT: Invalidate AFTER the write persists, never before — a concurrent
      // read otherwise repopulates the OLD value and it stays stale for the full
      // 5 minutes. Both key halves must match the read path exactly (`currentActor`
      // is the raw x-user-id, `updated.id` the resolved user_id) or this deletes nothing.
      await invalidateMeCache(req, currentActor, updated.id);

      return reply.send(serializeUser(updated));
    });

    // CONTRACT: Do NOT list this route in `shared/http/public-routes.ts` — that
    // absence is the only thing making the onRequest hook 401 a request without
    // x-user-id, so adding it leaves account deletion unauthenticated. 204 with no
    // body: the deleted row must not be echoed back. 502 = a failed cascade leg.
    // See [[soft-delete]]
    r.delete("/v1/users/me", {
      schema: {
        tags: ["users"], operationId: "deleteMe", summary: "Delete the current user's account",
        headers: UserIdHeader,
        response: { 204: z.null(), 404: ErrorSchema, 502: ErrorSchema },
      },
    }, async (req, reply) => {
      const { deleteAccountCommand, currentUser } = req.diScope.cradle;
      const result = await deleteAccountCommand.execute(currentUser);
      return result === "deleted"
        ? reply.code(204).send(null)
        : reply.code(404).send({ error: "not_found" });
    });

    // CONTRACT: This endpoint sets the password and clears `mustChangePassword`,
    // nothing else. Keep it separate from PATCH /v1/users/me and keep its body at
    // one field — merging them lets a profile update double as a credential rewrite
    // and makes the audit trail unable to tell the two apart.
    // See [[audit-fields]]
    r.patch("/v1/users/me/password", {
      schema: {
        tags: ["users"], operationId: "changeMyPassword",
        summary: "Change the current user's password",
        description:
          "Sets a new password for the authenticated caller and clears mustChangePassword. " +
          "Accepts no other user fields — use PATCH /v1/users/me for profile changes.",
        headers: UserIdHeader,
        body: ChangePasswordInputSchema,
        response: { 200: UserSchema, 404: ErrorSchema },
      },
    }, async (req, reply) => {
      const { changePasswordCommand, currentUser, currentActor } = req.diScope.cradle;
      const updated = await changePasswordCommand.execute(currentUser, req.body);
      if (!updated) return reply.code(404).send({ error: "not_found" });

      // CONTRACT: A password change must invalidate the profile cache. No password
      // is cached, but this command clears `mustChangePassword`, a field of the
      // cached GET /v1/users/me body — without this the frontend reads it as true
      // for five more minutes and loops the user through the forced-change flow.
      await invalidateMeCache(req, currentActor, updated.id);

      return reply.send(serializeUser(updated));
    });

    // WARNING: PUBLIC at the API Gateway — no JWT authorizer. Its callers are the
    // Cognito Lambda shim and the service itself, so the shared secret is its only
    // guard. Keep the payload OUT of `schema.body`: it is parsed manually below so
    // an invalid payload answers 422 rather than Fastify's schema-validation 400.
    // Floci never invokes Cognito triggers, so register() calls the same command
    // in-process when NODE_ENV !== "production".
    r.post("/v1/webhooks/cognito", {
      schema: {
        tags: ["webhooks"], operationId: "cognitoWebhook",
        summary: "Cognito PostConfirmation trigger webhook",
        headers: WebhookSecretHeader,
        response: {
          200: z.object({ status: z.string() }),
          401: ErrorSchema,
          422: z.object({ error: z.literal("invalid_payload"), details: z.array(z.unknown()) }),
          500: ErrorSchema,
        },
      },
    }, async (req, reply) => {
      const { env: e, captureCognitoIdentityCommand } = req.diScope.cradle;

      if (!verifyWebhookSecret(req.headers["x-webhook-secret"], e.WEBHOOK_SECRET)) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const parsed = cognitoWebhookPayloadSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: "invalid_payload", details: parsed.error.issues });
      }

      try {
        const { status } = await captureCognitoIdentityCommand.execute(parsed.data);
        return reply.code(200).send({ status });
      } catch (err) {
        if (err instanceof NoMatchingUserError) {
          // CONTRACT: Answer 500, not 404/409 — a confirmed Cognito identity with no
          // users row is a server-side inconsistency, and Cognito retries the trigger
          // on a non-2xx so a transient race self-heals. Do NOT log the
          // `cognito_webhook_no_match` line here: this point is outside the already-ended
          // `cognito_webhook` span, so the line lands under a different span_id.
          // See [[logging-context]]
          return reply.code(500).send({ error: "no_matching_user" });
        }
        throw err;
      }
    });

    if (container.cradle.env.E2E_TESTING_ENABLED) {
      r.delete("/v1/users/e2e-cleanup", {
        schema: {
          tags: ["e2e"], operationId: "e2eCleanup", summary: "[E2E] Delete E2E-sourced users",
          response: { 200: E2ECleanupResponseSchema },
        },
      }, async (req, reply) => {
        const { e2eCleanupCommand } = req.diScope.cradle;
        const { count } = await e2eCleanupCommand.execute();
        return reply.send({ deleted: count });
      });

      // Read-only: lets the E2E suite assert that identity capture wrote its rows.
      r.get("/v1/users/e2e-identity", {
        schema: {
          tags: ["e2e"], operationId: "e2eIdentity", summary: "[E2E] Read captured identity by email",
          querystring: z.object({ email: z.string().optional() }),
          response: { 200: z.object({}).passthrough(), 400: ErrorSchema },
        },
      }, async (req, reply) => {
        const { e2eIdentityQuery } = req.diScope.cradle;
        const email = req.query.email;
        if (!email) return reply.code(400).send({ error: "email_required" });
        return reply.send(await e2eIdentityQuery.execute(email));
      });
    }
  });

  return app;
}
