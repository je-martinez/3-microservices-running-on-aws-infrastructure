import Fastify, { type FastifyInstance } from "fastify";
import { fastifyAwilixPlugin, type Cradle } from "@fastify/awilix";
import { asValue, type AwilixContainer } from "awilix";
import { diContainer, registerSingletons, registerServices } from "#shared/di/awilix-container";
import { actorContext } from "#shared/audit/actor-context";
import type { UpdateProfileInput } from "../commands/update-profile.ts";
import { cognitoWebhookPayloadSchema } from "../webhooks/cognito-payload.ts";
import { verifyWebhookSecret } from "../webhooks/verify-secret.ts";
import { NoMatchingUserError } from "../webhooks/capture-cognito-identity.ts";

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

  return app;
}
