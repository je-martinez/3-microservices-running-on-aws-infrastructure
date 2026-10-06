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
      "functions/events-pipeline/src/handlers/**",
      "services/users/src/users/commands/*-otp-challenge.command.ts",
    ],
    primitive: "flow",
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
    data: authPasswordSigninRefresh,
  },
  {
    id: "users-cognito-identity-webhook",
    title: "Cognito identity capture",
    output: out("users-cognito-identity-webhook"),
    watches: ["services/users/src/**", "infra/modules/cognito/**"],
    primitive: "flow",
    data: usersCognitoIdentityWebhook,
  },
  {
    id: "users-account-deletion-cascade",
    title: "Account deletion cascade",
    output: out("users-account-deletion-cascade"),
    watches: ["services/users/src/**", "services/orders/**", "services/tracking-go/**"],
    primitive: "flow",
    data: usersAccountDeletionCascade,
  },
];
