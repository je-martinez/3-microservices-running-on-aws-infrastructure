import Fastify, { type FastifyInstance } from "fastify";
import { fastifyAwilixPlugin, type Cradle } from "@fastify/awilix";
import { asValue, asFunction, Lifetime, type AwilixContainer } from "awilix";
import { diContainer, registerSingletons, registerServices } from "#shared/di/awilix-container";
import { actorContext } from "#shared/audit/actor-context";
import { AuthError } from "#shared/auth/auth-errors";
import { RecordNotFoundError } from "#shared/db/db-errors";
import { CascadeFailedError } from "#shared/http/cascade-client";
import { buildLoggerOptions } from "#shared/logging/logger";
import { logContext } from "#shared/logging/log-context";
import { REQUEST_ID_HEADER, resolveRequestId } from "#shared/logging/request-id";
import { withHttpServerSpan } from "#shared/observability/request-span";
import { env } from "#shared/config/env";
import { isPublicRoute } from "#shared/http/public-routes";
import { CurrentUser } from "#shared/auth/current-user";
import type { Db } from "#shared/db/prisma";
import { cognitoWebhookPayloadSchema } from "../webhooks/cognito-payload.ts";
import { verifyWebhookSecret } from "../webhooks/verify-secret.ts";
import { NoMatchingUserError } from "../webhooks/capture-cognito-identity.ts";
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

// `fastify-type-provider-zod` emits BOTH an output variant (`User`) and an
// input variant (`UserInput`) for every schema in `z.globalRegistry`, by design
// — the suffix is not configurable. Our registered schemas (User/AuthTokens/
// Error) are response-only, so their `*Input` twins are orphans that no `$ref`
// points at; they just bloat the spec (confusing when imported into Apidog).
// Wrap the provider's transformObject and drop any component with zero inbound
// `$ref` in the finished document. Operating on the OpenAPI object here (before
// @fastify/swagger serializes it) is robust to YAML formatting — no textual
// stripping. A future `*Input` that IS referenced keeps a `$ref` and survives.
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
  UserIdHeader, WebhookSecretHeader,
} from "./schemas.ts";

// `User` (the domain shape returned by commands/queries) carries real `Date`
// fields; `UserSchema` documents the wire shape as ISO strings (see
// schemas.ts). Convert at the HTTP boundary — Zod's serializer strictly
// rejects a `Date` against `z.string()`, it does not coerce.
function serializeUser(user: User) {
  return {
    ...user,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    deletedAt: user.deletedAt ? user.deletedAt.toISOString() : null,
  };
}

// Builds the Fastify app wired to an Awilix container. Commands/queries are resolved
// per-request from `request.diScope` instead of a hand-rolled deps bag (see
// shared/di/awilix-container.ts for registration). Defaults to the shared `diContainer`
// singleton; tests can pass an isolated container pre-loaded with mocked services.
//
// `opts.logStream` is an optional second param (not part of the container arg) that lets
// tests capture the schema log output instead of writing to stdout — see
// `tests/shared/request-log.test.ts`.
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
    // Fastify's built-in request logging is OFF because the onResponse hook
    // below replaces it. Without this the service emitted TWO lines per request,
    // BOTH saying "request completed" — Fastify's own (carrying `res.statusCode`
    // and `responseTime`) and the schema-aligned one (carrying `http_route`,
    // `http_response_status_code`, `duration_ms`).
    //
    // That is worse than simple duplication: every request-rate figure computed
    // from the message was DOUBLE the real count, and half the rows answered a
    // `http_route` filter with nothing because they had no such field. Measured
    // with a single registration request: 2 lines, one of each shape.
    //
    // The hook's comment always claimed it replaced the default. It did not —
    // it added to it.
    disableRequestLogging: true,
  });

  // Emits one schema-aligned log per response (OTel-style HTTP semantic
  // conventions), replacing Fastify's default per-request start/end logs.
  app.addHook("onResponse", (req, reply, done) => {
    const route = req.routeOptions?.url ?? req.url;

    // The liveness probe is exempt WHILE IT SUCCEEDS — see [[health-check-logging]].
    // A succeeding probe is the one request whose log line carries nothing: the
    // container being up already says it, and its duration is a constant. A
    // FAILING one carries the status and latency that explain why, so it falls
    // through and is logged like any other request.
    //
    // Scoped by status rather than by suppressing the route, which is what keeps
    // the failure visible. Measured in Tracking before this was standardised
    // across the services: 353 of 368 lines in an hour were this one request at
    // 200, against 2 describing real work.
    const isHealthySoak =
      route === HEALTH_ROUTE &&
      reply.statusCode >= 200 &&
      reply.statusCode < 300;

    if (!isHealthySoak) {
      // Emitted with the request's HTTP SERVER span active, NOT with whatever
      // span happens to be active in this hook. `@fastify/otel` wraps every
      // Fastify hook in its own span, so without this the logger's formatter
      // stamps `span_id` = the "onResponse - fastify -> @fastify/otel" hook
      // span, and clicking `POST /v1/users/register` in OpenObserve -> "View
      // logs" (a `span_id`+`trace_id` filter) returns NOTHING — the one line
      // carrying http_route/status/duration is filed under a span nobody looks
      // at. See shared/observability/request-span.ts for the measured span tree
      // and why RPC metadata is the supported way to reach that span.
      //
      // NOT the JE-77 trap ([[grpc-context-activate-at-dispatch]]): that one is
      // about activating a context around a callback that returns before the
      // real work is dispatched. Here the work IS the `req.log.info` call, which
      // Pino performs synchronously inside this callback, so the span is still
      // active when the record is formatted. The test asserts the resulting
      // `span_id` rather than trusting that reasoning.
      withHttpServerSpan(req, () => {
        req.log.info(
          {
            http_request_method: req.method,
            http_route: route,
            http_response_status_code: reply.statusCode,
            duration_ms: reply.elapsedTime,
            // NO `trace_id: req.id` here. The REAL OTel trace_id and span_id are
            // stamped on every line by shared/logging/logger.ts's formatter, read
            // from the active span, and explicit fields beat the ambient ones — so
            // passing Fastify's local request counter would override the real id on
            // the single most useful log line, breaking the join between logs and
            // traces.
            //
            // This used to credit @opentelemetry/instrumentation-pino for the
            // injection. That package is not a dependency of this service and is
            // not in getNodeAutoInstrumentations' bundle, so nothing was injecting
            // anything and every line here shipped WITHOUT a trace id — see the
            // formatter's comment.
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
      // The whole hook is guarded: an observation of a response that already
      // went out must never become an error of its own. Resolution itself can
      // throw (a test container that registers no `metricsPublisher`), which
      // Fastify would otherwise surface as a request error on an already-sent
      // response.
      try {
        // Deliberately NOT awaited: `onResponse` runs after the response has
        // been sent, and awaiting here would delay the connection teardown for
        // the duration of a PutMetricData round trip. `publish()` never rejects
        // (it logs and swallows), so there is no unhandled rejection to catch.
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

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Maps domain `AuthError`s (InvalidCredentialsError/EmailAlreadyExistsError,
  // see shared/auth/auth-errors.ts) thrown by login/register commands to their
  // HTTP status. Everything else (Zod validation 400s, unexpected 500s) keeps
  // Fastify's default handling — re-throw so the framework's default error
  // handler produces the exact same body as before this change.
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
    if (error instanceof CascadeFailedError) {
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

  // Identity comes from the API Gateway authorizer (claims forwarded as headers).
  // Registered per-request in `request.diScope` for handlers that need it directly
  // (e.g. `/users/me`), AND run through `actorContext.run(...)` so the Prisma audit
  // extension can read the same actor from AsyncLocalStorage for its whole async call
  // chain (see [[audit-fields]] and `shared/audit/actor-context.ts`). `done()` is called
  // from *inside* the `als.run` callback — that's what makes the rest of the request's
  // hook/handler chain (which Fastify continues asynchronously off of this `done()` call)
  // inherit the store.
  //
  // Also enforces auth: a missing x-user-id on a non-public route (see
  // `shared/http/public-routes.ts`) short-circuits with 401 before any handler
  // runs. `req.routeOptions?.url` is the route's registered template (e.g.
  // "/v1/users/me"), matching `isPublicRoute`'s allowlist; it falls back to
  // `req.url` for the rare case it isn't populated yet at this hook stage.
  app.addHook("onRequest", (req, reply, done) => {
    const actor = req.headers["x-user-id"] as string | undefined;
    const routePath = req.routeOptions?.url ?? req.url;

    // Resolved and ATTACHED before the auth guard below, which short-circuits
    // with `return` rather than `done()`. A 401 is a request someone will ask
    // about, so it is the last one that should be missing its correlation id —
    // and `enterWith` is what puts the id on the reply's own log line, since
    // that branch never reaches the `logContext.run` wrapper further down.
    const request_id = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    logContext.enterWith({ request_id });

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
    // Seed the per-request log context so EVERY log line of this request
    // carries the caller's identity without any call site passing it (the
    // logger's `formatters.log` merges this store — see shared/logging/).
    // Commands enrich it later via `setLogContext` once they learn more (the
    // resolved user_id, the email hash on auth flows).
    //
    // Nested inside actorContext.run rather than using enterWith: this hook
    // already wraps `done` in a store, so the log context wraps the same
    // continuation and both are live for the whole request.
    actorContext.run({ actor }, () => {
      logContext.run(
        actor === undefined ? { request_id } : { request_id, cognito_sub: actor },
        done,
      );
    });
  });

  // `app.after()` defers route registration until after `fastifySwagger`'s
  // internal `onRoute` hook is attached (its `register()` call above is
  // asynchronous/avvio-deferred, so routes added synchronously right after it
  // would otherwise be missed by the spec — see @fastify/swagger's dynamic
  // mode, which builds `paths` from routes captured by that hook).
  //
  // ORDERING INVARIANT: the `onRequest` actor-context hook and the
  // `fastifyAwilixPlugin` registration MUST stay declared above this
  // `app.after()`. Routes registered inside the callback inherit hooks and
  // decorators already registered on this (root) context; `app.after()` does
  // NOT create a child encapsulation context. Moving either below this block
  // would silently drop `currentActor`/`diScope` from every route.
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

    // Password reset, step 1 of 2. SELF-OWNED flow: this service mints, stores
    // (hashed) and later verifies the code itself — Cognito's ForgotPassword is
    // not called anywhere, because it emails its own code, never returns it, and
    // accepts only its own at ConfirmForgotPassword.
    //
    // ==== ALWAYS 202, EVEN FOR AN UNKNOWN EMAIL ====
    // The response is a fixed body and a fixed status whether or not the address
    // belongs to an account. That is a SECURITY PROPERTY (no user enumeration),
    // not a missing error case — do not "improve" it into a 404. See the same
    // note in commands/forgot-password.ts, which is where the branch actually is.
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
      const { updateProfileCommand, currentUser } = req.diScope.cradle;
      const updated = await updateProfileCommand.execute(currentUser, req.body);
      return updated
        ? reply.send(serializeUser(updated))
        : reply.code(404).send({ error: "not_found" });
    });

    // Account deletion. Deliberately ABSENT from `shared/http/public-routes.ts`:
    // that absence is what makes the onRequest hook answer 401 without an
    // x-user-id. Listing it there would leave account deletion unauthenticated.
    //
    // 204 rather than 200-with-a-body: there is nothing left to describe, and the
    // deleted row must not be echoed back. The 502 comes from the error handler
    // when a cascade leg fails — see CascadeFailedError above.
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

    // The DEDICATED change-password endpoint. It does ONE thing: set the new
    // password (and clear `mustChangePassword`, which that act satisfies). It is
    // separate from PATCH /v1/users/me on purpose and MUST STAY separate — its
    // body accepts exactly one field, so a profile update can never
    // double as a credential rewrite, and the audit trail can always say which
    // of the two a given call was (`users_api:change_password` vs
    // `users_api:update_profile`).
    //
    // Authenticated like the other /me routes: identity comes from `x-user-id`,
    // put there by the gateway's JWT authorizer, and the onRequest hook 401s a
    // request without it before this handler runs.
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
      const { changePasswordCommand, currentUser } = req.diScope.cradle;
      const updated = await changePasswordCommand.execute(currentUser, req.body);
      return updated
        ? reply.send(serializeUser(updated))
        : reply.code(404).send({ error: "not_found" });
    });

    // Thin layer (spec D2): verify the shared secret, validate, delegate. The
    // command is the single persistence path — register() calls the same class
    // in-process when NODE_ENV !== "production", because Floci never invokes
    // Cognito Lambda triggers (ADR-0017).
    //
    // This is a PUBLIC route at the API Gateway (no JWT authorizer): its callers
    // are the Cognito Lambda shim and the service itself, never a user with a JWT.
    // The shared secret is its only guard.
    //
    // NOTE: the payload is deliberately NOT declared in `schema.body` — it is
    // validated manually below via `cognitoWebhookPayloadSchema.safeParse` so
    // an invalid payload returns 422 (not Fastify's schema-validation 400).
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
          // A confirmed Cognito identity with no matching users row is a
          // server-side inconsistency, not a client error (see this task's
          // header note for the 404/409 alternatives considered). Cognito
          // retries the trigger in prod on a non-2xx, so a transient race
          // self-heals.
          //
          // The `cognito_webhook_no_match` line is emitted by the command, not
          // here: this point is OUTSIDE the `cognito_webhook` span, which has
          // already ended by the time the error surfaces, so a line logged here
          // carries a different span_id and is invisible from the span in
          // OpenObserve. Logging it in both places would double-count the
          // failure instead.
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
