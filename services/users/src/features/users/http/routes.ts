import Fastify, { type FastifyInstance } from "fastify";
import { fastifyAwilixPlugin, type Cradle } from "@fastify/awilix";
import { asValue, type AwilixContainer } from "awilix";
import { diContainer, registerSingletons, registerServices } from "../../../shared/di/awilix-container.js";
import type { UpdateProfileInput } from "../commands/update-profile.js";

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
  // Registered per-request so `currentActor` is available in `request.diScope` for
  // any use-case that needs the acting user for audit stamping (see [[audit-fields]]).
  app.addHook("onRequest", (req, _reply, done) => {
    req.diScope.register({
      currentActor: asValue(req.headers["x-user-id"] as string | undefined),
    });
    done();
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

  if (container.cradle.env.E2E_TESTING_ENABLED) {
    app.delete("/v1/users/e2e-cleanup", async (req, reply) => {
      const { e2eCleanupCommand } = req.diScope.cradle;
      const { count } = await e2eCleanupCommand.execute();
      return reply.send({ deleted: count });
    });
  }

  return app;
}
