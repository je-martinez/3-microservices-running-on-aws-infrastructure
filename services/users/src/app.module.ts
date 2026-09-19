import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AppConfigModule } from "#config/config.module";
import { PrismaModule } from "#shared/prisma/prisma.module";
import { AuthModule } from "#shared/auth/auth.module";
import { CacheModule } from "#shared/cache/cache.module";
import { MessagingModule } from "#shared/messaging/messaging.module";
import { MetricsModule } from "#shared/metrics/metrics.module";
import { DomainExceptionFilter } from "#shared/http/domain-exception.filter";
import { RequestContextMiddleware } from "#shared/http/request-context.middleware";
import { AuthGuard } from "#shared/auth/auth.guard";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";
import { ResponseLogInterceptor } from "#shared/http/response-log.interceptor";
import { UsersModule } from "./users/users.module.ts";
import { NotificationsModule } from "./notifications/notifications.module.ts";
import { HealthController } from "./health/health.controller.ts";

// The composition root. The shared modules below are @Global, so a feature
// module needs no import line to reach config or the Prisma client.
@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    MetricsModule,
    AuthModule,
    CacheModule,
    MessagingModule,
    CqrsModule,
    UsersModule,
    NotificationsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    // CONTRACT: Auth is a GUARD, not part of the middleware. A guard sees the
    // matched handler, so a public route is marked with @Public() instead of
    // being matched against a hand-maintained path allowlist.
    { provide: APP_GUARD, useClass: AuthGuard },
    // CONTRACT: WorkflowInterceptor must be a provider, not merely a class.
    // @nestjs/cqrs never runs APP_INTERCEPTOR, so this interceptor wraps every
    // @Workflow handler's execute() in onApplicationBootstrap instead — a
    // lifecycle hook that only fires if Nest instantiates it. Without this
    // registration the bus emits no workflow spans AND a RoutineFailure reaches
    // the controller unwrapped, turning a routine 404 into a 500.
    { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseLogInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Seeds the actor and log-context stores for every request, including the
    // ones the guard goes on to reject — a 401 still carries its request id.
    consumer.apply(RequestContextMiddleware).forRoutes("*");
  }
}
