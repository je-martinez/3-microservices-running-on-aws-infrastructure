import { CognitoJwtVerifier } from "aws-jwt-verify";

// The verifier caches the pool's JWKS, so it is built once per container and
// reused across invocations — building it per call would fetch the JWKS on
// every connection.
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifier() {
  if (verifier === null) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.COGNITO_USER_POOL_ID ?? "",
      tokenUse: "access",
      clientId: process.env.COGNITO_CLIENT_ID ?? "",
    });
  }
  return verifier;
}

/**
 * Verify a Cognito access token and return its subject.
 *
 * Throws on ANY failure — absent, malformed, expired, wrong audience, bad
 * signature. Callers must treat a rejection as Deny and never distinguish the
 * reasons to the client: telling an unauthenticated caller *why* it failed
 * hands them a probing oracle.
 */
export async function verifyCognitoToken(token: string): Promise<{ sub: string }> {
  if (!token) {
    throw new Error("missing token");
  }
  const payload = await getVerifier().verify(token);
  return { sub: String(payload.sub) };
}
