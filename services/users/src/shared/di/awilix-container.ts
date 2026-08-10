import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { SQSClient } from "@aws-sdk/client-sqs";
import { diContainer } from "@fastify/awilix";
import { asValue, asFunction, asClass, Lifetime } from "awilix";
import { env, type Env } from "../config/env.ts";
import { db, type Db } from "../db/prisma.ts";
// `NoopEventPublisher` stays imported and exported from that module — it is
// still registered by tests that must not emit.
import { SqsEventPublisher, type EventPublisher } from "../messaging/event-publisher.ts";
import { CognitoAuthProvider } from "../auth/cognito-auth-provider.ts";
import type { AuthProvider } from "../auth/auth-provider.ts";
import { createRedisClient, type RedisClient } from "../cache/redis.ts";
import { ResetCodeStore } from "../cache/reset-code-store.ts";
import { RegisterUserCommand } from "#features/users/commands/register";
import { RegisterPasswordlessCommand } from "#features/users/commands/register-passwordless";
import { LoginUserCommand } from "#features/users/commands/login";
import { StartOtpChallengeCommand } from "#features/users/commands/start-otp-challenge";
import { VerifyOtpChallengeCommand } from "#features/users/commands/verify-otp-challenge";
import { RefreshTokenCommand } from "#features/users/commands/refresh";
import { UpdateProfileCommand } from "#features/users/commands/update-profile";
import { ForgotPasswordCommand } from "#features/users/commands/forgot-password";
import { ConfirmPasswordResetCommand } from "#features/users/commands/confirm-password-reset";
import { ChangePasswordCommand } from "#features/users/commands/change-password";
import { UserQueryService } from "#features/users/queries/get-me";
import { E2eCleanupCommand } from "#features/users/http/e2e-cleanup";
import { E2eIdentityQuery } from "#features/users/http/e2e-identity";
import { CaptureCognitoIdentityCommand } from "#features/users/webhooks/capture-cognito-identity";

// Type-safe resolution for `app.diContainer.cradle.<x>` / `request.diScope.resolve('<x>')`.
// `Cradle` holds app-scoped singletons (db clients, auth, events, env, service classes).
declare module "@fastify/awilix" {
  interface Cradle {
    env: Env;
    db: Db;
    cognitoClient: CognitoIdentityProviderClient;
    sqsClient: SQSClient;
    auth: AuthProvider;
    events: EventPublisher;
    redis: RedisClient;
    resetCodeStore: ResetCodeStore;
    registerUserCommand: RegisterUserCommand;
    registerPasswordlessCommand: RegisterPasswordlessCommand;
    loginUserCommand: LoginUserCommand;
    startOtpChallengeCommand: StartOtpChallengeCommand;
    verifyOtpChallengeCommand: VerifyOtpChallengeCommand;
    refreshTokenCommand: RefreshTokenCommand;
    updateProfileCommand: UpdateProfileCommand;
    forgotPasswordCommand: ForgotPasswordCommand;
    confirmPasswordResetCommand: ConfirmPasswordResetCommand;
    changePasswordCommand: ChangePasswordCommand;
    userQueryService: UserQueryService;
    e2eCleanupCommand: E2eCleanupCommand;
    e2eIdentityQuery: E2eIdentityQuery;
    captureCognitoIdentityCommand: CaptureCognitoIdentityCommand;
  }

  // `RequestCradle` holds per-request registrations (see `registerRequestScope` in
  // routes.ts, registered via `request.diScope.register(...)` in an `onRequest` hook).
  // `currentActor` is the identity from the API Gateway authorizer's `x-user-id` header.
  // It's kept here for handlers that need it directly (e.g. resolving "me"), but audit
  // stamping itself reads the actor from AsyncLocalStorage (see
  // `shared/audit/actor-context.ts`) since the Prisma client is a singleton and its
  // query extension can't reach into a per-request Awilix scope. `routes.ts` populates
  // both from the same header in the same `onRequest` hook.
  interface RequestCradle {
    currentActor: string | undefined;
    currentUser: import("../auth/current-user.ts").CurrentUser;
  }
}

// Registers the service's shared singletons into the Awilix `diContainer`.
// Must be called once, before `app.register(fastifyAwilixPlugin)` resolves anything
// eagerly and before routes attempt `request.diScope.resolve(...)`.
export function registerSingletons(): void {
  diContainer.register({
    env: asValue(env),
    db: asValue(db),
    cognitoClient: asFunction(
      ({ env: cradleEnv }: { env: Env }) =>
        new CognitoIdentityProviderClient({
          region: cradleEnv.AWS_REGION,
          endpoint: cradleEnv.AWS_ENDPOINT_URL,
        }),
      { lifetime: Lifetime.SINGLETON },
    ),
    auth: asFunction(
      ({ cognitoClient, env: cradleEnv }: { cognitoClient: CognitoIdentityProviderClient; env: Env }) =>
        new CognitoAuthProvider(cognitoClient, cradleEnv.COGNITO_USER_POOL_ID, cradleEnv.COGNITO_CLIENT_ID),
      { lifetime: Lifetime.SINGLETON },
    ),
    sqsClient: asFunction(
      ({ env: cradleEnv }: { env: Env }) =>
        new SQSClient({
          region: cradleEnv.AWS_REGION,
          endpoint: cradleEnv.AWS_ENDPOINT_URL,
        }),
      { lifetime: Lifetime.SINGLETON },
    ),
    events: asFunction(
      ({ sqsClient, env: cradleEnv }: { sqsClient: SQSClient; env: Env }) =>
        new SqsEventPublisher(sqsClient, cradleEnv.EVENTS_QUEUE_URL),
      { lifetime: Lifetime.SINGLETON },
    ),
    // SINGLETON, like every other connection-holding client here: ioredis owns a
    // real TCP socket and its own reconnect state machine, so a per-request
    // instance would open (and leak) a connection per request.
    redis: asFunction(
      ({ env: cradleEnv }: { env: Env }) =>
        createRedisClient({ host: cradleEnv.REDIS_HOST, port: cradleEnv.REDIS_PORT }),
      { lifetime: Lifetime.SINGLETON },
    ),
    // Stateless wrapper over `redis`, so it costs nothing to share and there is
    // no per-request state to keep apart — SINGLETON alongside its client.
    resetCodeStore: asClass(ResetCodeStore, { lifetime: Lifetime.SINGLETON }),
  });
}

// Registers the use-case classes (commands/queries) resolved from the shared
// singletons above. Split from `registerSingletons` so infra collaborators and
// application services stay easy to tell apart at the registration call site.
export function registerServices(): void {
  diContainer.register({
    registerUserCommand: asClass(RegisterUserCommand, { lifetime: Lifetime.SCOPED }),
    registerPasswordlessCommand: asClass(RegisterPasswordlessCommand, { lifetime: Lifetime.SCOPED }),
    loginUserCommand: asClass(LoginUserCommand, { lifetime: Lifetime.SCOPED }),
    startOtpChallengeCommand: asClass(StartOtpChallengeCommand, { lifetime: Lifetime.SCOPED }),
    verifyOtpChallengeCommand: asClass(VerifyOtpChallengeCommand, { lifetime: Lifetime.SCOPED }),
    refreshTokenCommand: asClass(RefreshTokenCommand, { lifetime: Lifetime.SCOPED }),
    updateProfileCommand: asClass(UpdateProfileCommand, { lifetime: Lifetime.SCOPED }),
    forgotPasswordCommand: asClass(ForgotPasswordCommand, { lifetime: Lifetime.SCOPED }),
    confirmPasswordResetCommand: asClass(ConfirmPasswordResetCommand, { lifetime: Lifetime.SCOPED }),
    changePasswordCommand: asClass(ChangePasswordCommand, { lifetime: Lifetime.SCOPED }),
    userQueryService: asClass(UserQueryService, { lifetime: Lifetime.SCOPED }),
    e2eCleanupCommand: asClass(E2eCleanupCommand, { lifetime: Lifetime.SCOPED }),
    e2eIdentityQuery: asClass(E2eIdentityQuery, { lifetime: Lifetime.SCOPED }),
    captureCognitoIdentityCommand: asClass(CaptureCognitoIdentityCommand, { lifetime: Lifetime.SCOPED }),
  });
}

export { diContainer };
