import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import type { Db } from "#shared/db/prisma";
// CONTRACT: A value import, not `import type`. Nest resolves a provider by its
// runtime class; an erased type import makes the token `undefined` and the
// injector fails at BOOTSTRAP, not at compile time. See [[dependency-injection]]
import { CacheGateway } from "#shared/cache/cache-gateway";
import type { StripeClientHolder } from "#shared/stripe/stripe-client.provider";
import { DB, STRIPE_CLIENT } from "#shared/tokens";
import { CaptureCognitoIdentityCommand } from "#features/users/webhooks/capture-cognito-identity";
import { E2eCleanupCommand } from "#features/users/http/e2e-cleanup";
import { E2eIdentityQuery } from "#features/users/http/e2e-identity";
import { ChangePasswordHandler } from "./commands/change-password.command.ts";
import { ConfirmPasswordResetHandler } from "./commands/confirm-password-reset.command.ts";
import { DeleteAccountHandler } from "./commands/delete-account.command.ts";
import { ForgotPasswordHandler } from "./commands/forgot-password.command.ts";
import { LoginHandler } from "./commands/login.command.ts";
import { RefreshHandler } from "./commands/refresh.command.ts";
import { RegisterHandler } from "./commands/register.command.ts";
import { RegisterPasswordlessHandler } from "./commands/register-passwordless.command.ts";
import { SignOutHandler } from "./commands/sign-out.command.ts";
import { StartOtpChallengeHandler } from "./commands/start-otp-challenge.command.ts";
import { UpdateProfileHandler } from "./commands/update-profile.command.ts";
import { VerifyOtpChallengeHandler } from "./commands/verify-otp-challenge.command.ts";
import { GetMeHandler } from "./queries/get-me.query.ts";
import { GetUserByIdHandler } from "./queries/get-user-by-id.query.ts";
import { UsersController } from "./http/users.controller.ts";
import { E2eController } from "./http/e2e.controller.ts";
import { CurrentUserInterceptor } from "./http/current-user.interceptor.ts";
import { MeCacheInterceptor } from "#shared/cache/me-cache.interceptor";
import { CognitoWebhookController } from "./webhooks/cognito.controller.ts";
import { UsersGrpcController } from "./grpc/users-grpc.controller.ts";

// WHY: `@Module` evaluates at import time — match the Fastify `if (E2E_TESTING_ENABLED)`
// gate so these routes do not exist when the flag is off.
const e2eEnabled = process.env.E2E_TESTING_ENABLED === "true";

const e2eProviders = e2eEnabled
  ? [
      {
        provide: E2eCleanupCommand,
        // CONTRACT: STRIPE_CLIENT is `optional: true` — this command exists
        // whenever E2E_TESTING_ENABLED is set, independent of STRIPE_ENABLED.
        // PaymentMethodsModule (which provides STRIPE_CLIENT) is a sibling
        // under AppModule, never imported here, so the token is only visible
        // at all because that module is @Global() when mounted; when it is
        // not mounted, `optional: true` resolves this to `undefined` instead
        // of failing DI resolution at bootstrap. See [[dependency-injection]]
        inject: [DB, CacheGateway, { token: STRIPE_CLIENT, optional: true }],
        useFactory: (db: Db, cacheGateway: CacheGateway, stripe: StripeClientHolder | undefined) =>
          new E2eCleanupCommand({ db, cacheGateway, stripe }),
      },
      {
        provide: E2eIdentityQuery,
        inject: [DB],
        useFactory: (db: Db) => new E2eIdentityQuery({ db }),
      },
    ]
  : [];

// Handlers are discovered per module by @nestjs/cqrs; later tasks add theirs to
// `providers` and nothing else needs touching.
@Module({
  imports: [CqrsModule],
  controllers: [
    UsersController,
    CognitoWebhookController,
    UsersGrpcController,
    ...(e2eEnabled ? [E2eController] : []),
  ],
  providers: [
    GetMeHandler,
    GetUserByIdHandler,
    LoginHandler,
    ChangePasswordHandler,
    RegisterHandler,
    RegisterPasswordlessHandler,
    StartOtpChallengeHandler,
    VerifyOtpChallengeHandler,
    RefreshHandler,
    SignOutHandler,
    ForgotPasswordHandler,
    ConfirmPasswordResetHandler,
    UpdateProfileHandler,
    DeleteAccountHandler,
    CurrentUserInterceptor,
    MeCacheInterceptor,
    {
      provide: CaptureCognitoIdentityCommand,
      inject: [DB],
      useFactory: (db: Db) => new CaptureCognitoIdentityCommand({ db }),
    },
    ...e2eProviders,
  ],
})
export class UsersModule {}
