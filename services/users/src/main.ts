// CONTRACT: Do NOT import the OTel SDK here. It loads via `node --import`
// (Dockerfile CMD and the start/dev scripts) — the only ordering that works
// under ESM, where static imports are hoisted before any module body runs, so
// importing the SDK "first" still leaves @grpc/grpc-js loaded before
// sdk.start() can patch it. See [[logging-context]]
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildLoggerOptions } from "./shared/logging/logger.ts";
import { envSchema } from "./config/env.schema.ts";
import { AppModule } from "./app.module.ts";
import { NotificationConsumerService } from "./notifications/messaging/notification-consumer.service.ts";
import { type MicroserviceOptions } from "@nestjs/microservices";
import { grpcMicroserviceOptions } from "./users/grpc/grpc-options.ts";

const env = envSchema.parse(process.env);

export async function createNestApp(): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    logger: buildLoggerOptions({
      serviceName: "users",
      environment: env.DEPLOYMENT_ENVIRONMENT,
    }),
    // CONTRACT: Keep this true — ResponseLogInterceptor replaces Fastify's own
    // request log rather than adding to it. Re-enabling it emits TWO "request
    // completed" lines per request, doubling every request-rate figure and
    // leaving half the rows with no http_route to filter on.
    // See [[logging-context]]
    disableRequestLogging: true,
  });

  // CONTRACT: `rawBody: true` only adds `req.rawBody`; every other route's
  // `@Body()` is unaffected. Proved by stripe-webhook.controller.test.ts's
  // real signed-payload assertions, not re-tested here.
  return NestFactory.create<NestFastifyApplication>(AppModule, adapter, { rawBody: true });
}

export async function bootstrap(): Promise<void> {
  const app = await createNestApp();

  // The gRPC surface shares this process, its DI container and its bus.
  app.connectMicroservice<MicroserviceOptions>(grpcMicroserviceOptions(env));
  await app.startAllMicroservices();

  await app.listen({ port: env.PORT, host: "0.0.0.0" });

  // CONTRACT: Start the consumer HERE, never in a constructor or onModuleInit.
  // The test suite compiles this module many times over, and a lifecycle hook
  // would open a live long-poll in each one — receiving and DELETING real
  // messages outside any test's control.
  // See [[2026-09-10-in-app-notifications-design]]
  const consumer = app.get(NotificationConsumerService);
  consumer.start();

  process.on("SIGTERM", () => {
    consumer.stop();
  });
}

// Only the process entrypoint listens; a test importing createNestApp must not.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await bootstrap();
}
