import Fastify, { type FastifyInstance } from "fastify";

export interface AppDeps {
  env: { E2E_TESTING_ENABLED: boolean };
  registerUser: (deps: unknown, input: unknown) => Promise<{ id: string; tags: string[] }>;
  loginUser: (deps: unknown, input: { email: string; password: string }) => Promise<unknown>;
  getMe: (deps: unknown, userId: string) => Promise<unknown>;
  updateProfile: (deps: unknown, userId: string, input: unknown) => Promise<unknown>;
  softDeleteE2EUsers: (deps: unknown) => Promise<{ count: number }>;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/v1/health", async () => ({ status: "ok" }));

  app.post("/v1/users/register", async (req, reply) => {
    const body = req.body as { email: string; password: string; fullName: string; address?: unknown; phoneNumber?: string };
    const headerFlag = req.headers["x-e2e-source"] === "true";
    const e2eSource = headerFlag && deps.env.E2E_TESTING_ENABLED;
    const user = await deps.registerUser(deps, { ...body, e2eSource });
    return reply.code(201).send(user);
  });

  app.post("/v1/users/login", async (req, reply) => {
    const tokens = await deps.loginUser(deps, req.body as { email: string; password: string });
    return reply.send(tokens);
  });

  // Identity comes from the API Gateway authorizer (claims forwarded as headers).
  app.get("/v1/users/me", async (req, reply) => {
    const userId = req.headers["x-user-id"] as string;
    const me = await deps.getMe(deps, userId);
    return me ? reply.send(me) : reply.code(404).send({ error: "not_found" });
  });

  app.patch("/v1/users/me", async (req, reply) => {
    const userId = req.headers["x-user-id"] as string;
    const updated = await deps.updateProfile(deps, userId, req.body);
    return reply.send(updated);
  });

  if (deps.env.E2E_TESTING_ENABLED) {
    app.delete("/v1/users/e2e-cleanup", async (_req, reply) => {
      const { count } = await deps.softDeleteE2EUsers(deps);
      return reply.send({ deleted: count });
    });
  }

  return app;
}
