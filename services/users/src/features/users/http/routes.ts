import Fastify, { type FastifyInstance } from "fastify";
import { fastifyAwilixPlugin, type Cradle } from "@fastify/awilix";
import { asValue, type AwilixContainer } from "awilix";
import { diContainer, registerSingletons, registerServices } from "#shared/di/awilix-container";
import { actorContext } from "#shared/audit/actor-context";
import { AuthError } from "#shared/auth/auth-errors";
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
// Side-effect import: `schemas.ts` registers `UserSchema`/`AuthTokensSchema`/
// `ErrorSchema` in `z.globalRegistry` at module-eval time (see that file's
// bottom `z.globalRegistry.add(...)` calls), which is how they surface under
// `components/schemas` in the generated OpenAPI doc.
import "./schemas.ts";
import {
  RegisterInputSchema, LoginInputSchema, UpdateProfileInputSchema,
  RefreshInputSchema, RefreshedTokensSchema,
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
export function buildApp(container: AwilixContainer<Cradle> = diContainer): FastifyInstance {
  if (container === diContainer) {
    registerSingletons();
    registerServices();
  }

  const app = Fastify({ logger: true });

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
  app.addHook("onRequest", (req, _reply, done) => {
    const actor = req.headers["x-user-id"] as string | undefined;
    req.diScope.register({
      currentActor: asValue(actor),
    });
    actorContext.run({ actor }, done);
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

    r.get("/v1/users/me", {
      schema: {
        tags: ["users"], operationId: "getMe", summary: "Get the current user's profile",
        headers: UserIdHeader,
        response: { 200: UserSchema, 404: ErrorSchema },
      },
    }, async (req, reply) => {
      const { userQueryService, currentActor } = req.diScope.cradle;
      const me = currentActor ? await userQueryService.getMe(currentActor) : null;
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
      const { updateProfileCommand, currentActor } = req.diScope.cradle;
      const updated = await updateProfileCommand.execute(currentActor as string, req.body);
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
          req.log.error({ err }, "cognito webhook: no matching users row");
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
