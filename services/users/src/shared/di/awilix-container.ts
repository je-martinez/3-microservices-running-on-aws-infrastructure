import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { diContainer } from "@fastify/awilix";
import { asValue, asFunction, asClass, Lifetime } from "awilix";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { env, type Env } from "../config/env.js";
import { writer, reader } from "../db/prisma.js";
import { NoopEventPublisher, type EventPublisher } from "../messaging/event-publisher.js";
import { CognitoAuthProvider } from "../auth/cognito-auth-provider.js";
import type { AuthProvider } from "../auth/auth-provider.js";
import { RegisterUserCommand } from "../../features/users/commands/register.js";
import { LoginUserCommand } from "../../features/users/commands/login.js";
import { UpdateProfileCommand } from "../../features/users/commands/update-profile.js";
import { UserQueryService } from "../../features/users/queries/get-me.js";
import { E2eCleanupCommand } from "../../features/users/http/e2e-cleanup.js";

// Type-safe resolution for `app.diContainer.cradle.<x>` / `request.diScope.resolve('<x>')`.
// `Cradle` holds app-scoped singletons (db clients, auth, events, env, service classes).
declare module "@fastify/awilix" {
  interface Cradle {
    env: Env;
    writer: PrismaClient;
    reader: PrismaClient;
    cognitoClient: CognitoIdentityProviderClient;
    auth: AuthProvider;
    events: EventPublisher;
    registerUserCommand: RegisterUserCommand;
    loginUserCommand: LoginUserCommand;
    updateProfileCommand: UpdateProfileCommand;
    userQueryService: UserQueryService;
    e2eCleanupCommand: E2eCleanupCommand;
  }

  // `RequestCradle` holds per-request registrations (see `registerRequestScope` in
  // routes.ts, registered via `request.diScope.register(...)` in an `onRequest` hook).
  // `currentActor` is the identity used for audit stamping (see [[audit-fields]]); it
  // comes from the API Gateway authorizer's `x-user-id` header. Full adoption as the
  // single audit-actor source lands with the Prisma extension work (block 2) — for now
  // it is available in the cradle but `register` still stamps with the new row's own id
  // (see commands/register.ts).
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
    writer: asValue(writer),
    reader: asValue(reader),
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
    updateProfileCommand: asClass(UpdateProfileCommand, { lifetime: Lifetime.SCOPED }),
    userQueryService: asClass(UserQueryService, { lifetime: Lifetime.SCOPED }),
    e2eCleanupCommand: asClass(E2eCleanupCommand, { lifetime: Lifetime.SCOPED }),
  });
}

export { diContainer };
