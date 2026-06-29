import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { env } from "../config/env.js";
import { writer, reader } from "../db/prisma.js";
import { NoopEventPublisher } from "../messaging/event-publisher.js";
import { CognitoAuthProvider } from "../auth/cognito-auth-provider.js";
import { registerUser } from "../../features/users/commands/register.js";
import { loginUser } from "../../features/users/commands/login.js";
import { updateProfile } from "../../features/users/commands/update-profile.js";
import { getMe } from "../../features/users/queries/get-me.js";
import { softDeleteE2EUsers } from "../../features/users/http/e2e-cleanup.js";
import type { AppDeps } from "../../features/users/http/routes.js";

export function buildContainer(): AppDeps {
  const cognito = new CognitoIdentityProviderClient({
    region: env.AWS_REGION,
    endpoint: env.AWS_ENDPOINT_URL,
  });
  const auth = new CognitoAuthProvider(cognito, env.COGNITO_USER_POOL_ID, env.COGNITO_CLIENT_ID);
  const events = new NoopEventPublisher();
  return {
    env,
    registerUser: (_d, input) => registerUser({ writer, auth, events }, input as any),
    loginUser: (_d, input) => loginUser({ auth }, input),
    getMe: (_d, userId) => getMe({ reader }, userId),
    updateProfile: (_d, userId, input) => updateProfile({ writer }, userId, input as any),
    softDeleteE2EUsers: () => softDeleteE2EUsers({ writer }),
  };
}
