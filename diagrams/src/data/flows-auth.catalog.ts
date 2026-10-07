import type { CatalogEntry } from "../catalog";
import { authPasswordlessOtpSignin } from "./flows/auth-passwordless-otp-signin";
import { authPasswordSigninRefresh } from "./flows/auth-password-signin-refresh";
import { usersCognitoIdentityWebhook } from "./flows/users-cognito-identity-webhook";
import { usersAccountDeletionCascade } from "./flows/users-account-deletion-cascade";

const out = (id: string) => `docs/domains/users/specs/diagrams/${id}`;

export const authFlowEntries: CatalogEntry[] = [
  {
    id: "auth-passwordless-otp-signin",
    title: "Passwordless sign-in with an emailed code",
    output: out("auth-passwordless-otp-signin"),
    watches: [
      "infra/modules/cognito/**",
      "functions/events-pipeline/src/handlers/auth-otp-requested.ts",
      "services/users/src/users/commands/*-otp-challenge.command.ts",
    ],
    primitive: "flow",
    source: "diagrams/src/data/flows/auth-passwordless-otp-signin.ts",
    data: authPasswordlessOtpSignin,
  },
  {
    id: "auth-password-signin-refresh",
    title: "Password sign-in and token refresh",
    output: out("auth-password-signin-refresh"),
    watches: [
      "infra/modules/cognito/**",
      "infra/modules/api-gateway/**",
      "apps/web/src/app/core/auth/refresh-interceptor.ts",
    ],
    primitive: "flow",
    source: "diagrams/src/data/flows/auth-password-signin-refresh.ts",
    data: authPasswordSigninRefresh,
  },
  {
    id: "users-cognito-identity-webhook",
    title: "Cognito identity capture",
    output: out("users-cognito-identity-webhook"),
    watches: [
      "services/users/src/users/commands/register.command.ts",
      "services/users/src/users/commands/register-passwordless.command.ts",
      "services/users/src/users/webhooks/cognito.controller.ts",
      "services/users/src/features/users/webhooks/**",
    ],
    primitive: "flow",
    source: "diagrams/src/data/flows/users-cognito-identity-webhook.ts",
    data: usersCognitoIdentityWebhook,
  },
  {
    id: "users-account-deletion-cascade",
    title: "Account deletion cascade",
    output: out("users-account-deletion-cascade"),
    watches: [
      "services/users/src/users/commands/delete-account.command.ts",
      "services/users/src/shared/http/cascade-client.ts",
      "services/orders/src/Orders.Api/Endpoints/InternalEndpoints.cs",
      "services/orders/src/Orders.Infrastructure/Orders/DeleteOrdersByUserService.cs",
      "services/tracking-go/internal/adapter/http/handler_internal_delete.go",
      "services/tracking-go/internal/app/delete_by_user.go",
      "services/tracking-go/internal/adapter/mysql/soft_delete.go",
    ],
    primitive: "flow",
    source: "diagrams/src/data/flows/users-account-deletion-cascade.ts",
    data: usersAccountDeletionCascade,
  },
];
