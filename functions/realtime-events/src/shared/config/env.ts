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
    // CONTRACT: The issuer is CONFIGURATION, never derived from
    // userPoolId+region. Floci stamps a fixed host-facing `iss` that never
    // matches the real-AWS shape, and real AWS does not have this pool at all,
    // so a derived issuer rejects every token.
    // See [[floci-websocket-apigw-dynamodb-support]]
    issuer: required("COGNITO_ISSUER"),
    tableName: required("WS_CONNECTIONS_TABLE"),
    gsiName: process.env.WS_CONNECTIONS_GSI ?? "by-cognito-sub",
    awsRegion: process.env.AWS_REGION ?? "us-east-1",
    // Set locally so the SDK talks to Floci; unset in production so the SDK
    // resolves the real AWS endpoint. See the env-files convention.
    dynamoEndpoint: process.env.AWS_ENDPOINT_URL || undefined,
  };
}
