function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var: ${name}`);
  }
  return value;
}

export function getEnv() {
  return {
    userPoolId: required("COGNITO_USER_POOL_ID"),
    clientId: required("COGNITO_CLIENT_ID"),
    // The JWT issuer to verify tokens against — CONFIGURATION, not derived.
    // Floci stamps a fixed "http://localhost:4566/<pool-id>" `iss` claim on
    // every token it mints, which never matches the real-AWS
    // "https://cognito-idp.<region>.amazonaws.com/<pool-id>" shape a verifier
    // would otherwise assume. Real AWS also never has this pool at all, so
    // deriving the issuer from userPoolId+region is wrong even before the
    // local/prod split — it must be supplied, the same way
    // modules/cognito/outputs.tf's `issuer` output already is for the REST
    // API Gateway's native JWT authorizer (infra/modules/api-gateway/main.tf).
    issuer: required("COGNITO_ISSUER"),
    tableName: required("WS_CONNECTIONS_TABLE"),
    gsiName: process.env.WS_CONNECTIONS_GSI ?? "by-cognito-sub",
    awsRegion: process.env.AWS_REGION ?? "us-east-1",
    // Set locally so the SDK talks to Floci; unset in production so the SDK
    // resolves the real AWS endpoint. See the env-files convention.
    dynamoEndpoint: process.env.AWS_ENDPOINT_URL || undefined,
  };
}
