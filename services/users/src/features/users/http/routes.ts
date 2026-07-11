import Fastify, { type FastifyInstance } from "fastify";
import { fastifyAwilixPlugin, type Cradle } from "@fastify/awilix";
import { asValue, type AwilixContainer } from "awilix";
import { diContainer, registerSingletons, registerServices } from "#shared/di/awilix-container";
import { actorContext } from "#shared/audit/actor-context";
import type { UpdateProfileInput } from "../commands/update-profile.ts";
import { cognitoWebhookPayloadSchema } from "../webhooks/cognito-payload.ts";
import { verifyWebhookSecret } from "../webhooks/verify-secret.ts";
import { NoMatchingUserError } from "../webhooks/capture-cognito-identity.ts";
import fastifySwagger from "@fastify/swagger";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
// Side-effect import: `schemas.ts` registers `UserSchema`/`AuthTokensSchema`/
// `ErrorSchema` in `z.globalRegistry` at module-eval time (see that file's
// bottom `z.globalRegistry.add(...)` calls), which is how they surface under
// `components/schemas` in the generated OpenAPI doc. Kept as an explicit
// bare import (not folded into the named import below) because esbuild's
// isolated-modules transpile elides an *entirely unused* named-import
// statement — dropping this side effect — until Task 4 attaches these
// schemas to routes via `r.<verb>(..., { schema })`.
import "./schemas.ts";
// Imported here (unused for now) so Task 4 can attach them to routes via
// `r.<verb>(..., { schema })` without touching the import block again.
/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  RegisterInputSchema, LoginInputSchema, UpdateProfileInputSchema,
  UserSchema, AuthTokensSchema, ErrorSchema,
  HealthResponseSchema, E2ECleanupResponseSchema,
  UserIdHeader, WebhookSecretHeader,
} from "./schemas.ts";
/* eslint-enable @typescript-eslint/no-unused-vars */

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
    transformObject: jsonSchemaTransformObject,
  });

  // Unused until Task 4 rewires the route declarations below from `app.<verb>`
  // to `r.<verb>(..., { schema })` so they get Zod validation/serialization.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    app.get("/v1/health", async () => ({ status: "ok" }));

    app.post("/v1/users/register", async (req, reply) => {
      const body = req.body as { email: string; password: string; fullName: string; address?: unknown; phoneNumber?: string };
      const headerFlag = req.headers["x-e2e-source"] === "true";
      const { env, registerUserCommand } = req.diScope.cradle;
      const e2eSource = headerFlag && env.E2E_TESTING_ENABLED;
      const user = await registerUserCommand.execute({ ...body, e2eSource });
      return reply.code(201).send(user);
    });

    app.post("/v1/users/login", async (req, reply) => {
      const { loginUserCommand } = req.diScope.cradle;
      const tokens = await loginUserCommand.execute(req.body as { email: string; password: string });
      return reply.send(tokens);
    });

    app.get("/v1/users/me", async (req, reply) => {
      const { userQueryService, currentActor } = req.diScope.cradle;
      const me = currentActor ? await userQueryService.getMe(currentActor) : null;
      return me ? reply.send(me) : reply.code(404).send({ error: "not_found" });
    });

    app.patch("/v1/users/me", async (req, reply) => {
      const { updateProfileCommand, currentActor } = req.diScope.cradle;
      const updated = await updateProfileCommand.execute(currentActor as string, req.body as UpdateProfileInput);
      return reply.send(updated);
    });

    // Thin layer (spec D2): verify the shared secret, validate, delegate. The
    // command is the single persistence path — register() calls the same class
    // in-process when NODE_ENV !== "production", because Floci never invokes
    // Cognito Lambda triggers (ADR-0017).
    //
    // This is a PUBLIC route at the API Gateway (no JWT authorizer): its callers
    // are the Cognito Lambda shim and the service itself, never a user with a JWT.
    // The shared secret is its only guard.
    app.post("/v1/webhooks/cognito", async (req, reply) => {
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
      app.delete("/v1/users/e2e-cleanup", async (req, reply) => {
        const { e2eCleanupCommand } = req.diScope.cradle;
        const { count } = await e2eCleanupCommand.execute();
        return reply.send({ deleted: count });
      });

      // Read-only: lets the E2E suite assert that identity capture wrote its rows.
      app.get("/v1/users/e2e-identity", async (req, reply) => {
        const { e2eIdentityQuery } = req.diScope.cradle;
        const email = (req.query as { email?: string }).email;
        if (!email) return reply.code(400).send({ error: "email_required" });
        return reply.send(await e2eIdentityQuery.execute(email));
      });
    }
  });

  return app;
}
