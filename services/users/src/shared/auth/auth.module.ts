import { Global, Module } from "@nestjs/common";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { CognitoAuthProvider } from "#shared/auth/cognito-auth-provider";
import { CascadeClient } from "#shared/http/cascade-client";
import { AppConfigService } from "#config/config.module";
import { AUTH_PROVIDER } from "#shared/tokens";

const COGNITO_CLIENT = Symbol.for("users:cognitoClient");

@Global()
@Module({
  providers: [
    {
      provide: COGNITO_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new CognitoIdentityProviderClient({
          region: config.get("AWS_REGION"),
          endpoint: config.get("AWS_ENDPOINT_URL"),
        }),
    },
    {
      provide: AUTH_PROVIDER,
      inject: [COGNITO_CLIENT, AppConfigService],
      useFactory: (client: CognitoIdentityProviderClient, config: AppConfigService) =>
        new CognitoAuthProvider(
          client,
          config.get("COGNITO_USER_POOL_ID"),
          config.get("COGNITO_CLIENT_ID"),
        ),
    },
    {
      // Holds only configuration and a stateless fetch, so one instance is right.
      provide: CascadeClient,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new CascadeClient({
          ordersBaseUrl: config.get("ORDERS_BASE_URL"),
          trackingBaseUrl: config.get("TRACKING_BASE_URL"),
          apiKey: config.get("INTERNAL_API_KEY"),
        }),
    },
  ],
  exports: [AUTH_PROVIDER, CascadeClient],
})
export class AuthModule {}
