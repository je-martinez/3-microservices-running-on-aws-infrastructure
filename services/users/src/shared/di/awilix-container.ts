import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { diContainer } from "@fastify/awilix";
import { asValue, asFunction, asClass, Lifetime } from "awilix";
import { env, type Env } from "../config/env.ts";
import { db, type Db } from "../db/prisma.ts";
import { NoopEventPublisher, type EventPublisher } from "../messaging/event-publisher.ts";
import { CognitoAuthProvider } from "../auth/cognito-auth-provider.ts";
import type { AuthProvider } from "../auth/auth-provider.ts";
import { RegisterUserCommand } from "#features/users/commands/register";
import { LoginUserCommand } from "#features/users/commands/login";
import { RefreshTokenCommand } from "#features/users/commands/refresh";
import { UpdateProfileCommand } from "#features/users/commands/update-profile";
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
    auth: AuthProvider;
    events: EventPublisher;
    registerUserCommand: RegisterUserCommand;
    loginUserCommand: LoginUserCommand;
    refreshTokenCommand: RefreshTokenCommand;
    updateProfileCommand: UpdateProfileCommand;
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
    events: asFunction(() => new NoopEventPublisher(), { lifetime: Lifetime.SINGLETON }),
  });
}

// Registers the use-case classes (commands/queries) resolved from the shared
// singletons above. Split from `registerSingletons` so infra collaborators and
// application services stay easy to tell apart at the registration call site.
export function registerServices(): void {
  diContainer.register({
    registerUserCommand: asClass(RegisterUserCommand, { lifetime: Lifetime.SCOPED }),
    loginUserCommand: asClass(LoginUserCommand, { lifetime: Lifetime.SCOPED }),
    refreshTokenCommand: asClass(RefreshTokenCommand, { lifetime: Lifetime.SCOPED }),
    updateProfileCommand: asClass(UpdateProfileCommand, { lifetime: Lifetime.SCOPED }),
    userQueryService: asClass(UserQueryService, { lifetime: Lifetime.SCOPED }),
    e2eCleanupCommand: asClass(E2eCleanupCommand, { lifetime: Lifetime.SCOPED }),
    e2eIdentityQuery: asClass(E2eIdentityQuery, { lifetime: Lifetime.SCOPED }),
    captureCognitoIdentityCommand: asClass(CaptureCognitoIdentityCommand, { lifetime: Lifetime.SCOPED }),
  });
}

export { diContainer };
