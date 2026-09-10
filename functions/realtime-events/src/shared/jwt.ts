import { JwtRsaVerifier } from "aws-jwt-verify";
import { validateCognitoJwtFields } from "aws-jwt-verify/cognito-verifier";
import { SimpleJwksCache, type JwksCache } from "aws-jwt-verify/jwk";
import type { JsonFetcher } from "aws-jwt-verify/https";
import { getEnv } from "#shared/config/env";

// CONTRACT: Do NOT switch to the top-level `CognitoJwtVerifier`. It derives
// both `issuer` and `jwksUri` from `userPoolId`, spread LAST over anything
// passed in, so an override is silently discarded and every token — valid or
// garbage — fails verification identically. This uses the library's documented
// escape hatch, `JwtRsaVerifier` with an issuer from CONFIGURATION, plus
// `validateCognitoJwtFields` to keep the same tokenUse/clientId checks.
// See [[floci-websocket-apigw-dynamodb-support]]
const env = getEnv();

// WORKAROUND(local): aws-jwt-verify's default fetcher calls Node's `https`
// module directly and throws `Protocol "http:" not supported` against Floci's
// plain-HTTP JWKS endpoint. Global `fetch` has no such restriction. Scoped to
// AWS_ENDPOINT_URL, so production keeps the library's HTTPS-only fetcher.
// See [[floci-websocket-apigw-dynamodb-support]]
class LocalHttpJsonFetcher implements JsonFetcher {
  async fetch<ResultType>(uri: string): Promise<ResultType> {
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error(`JWKS fetch failed: ${uri} -> HTTP ${response.status}`);
    }
    return (await response.json()) as ResultType;
  }
}

// CONTRACT: Do NOT fetch the JWKS from `env.issuer`. The issuer CLAIM and the
// JWKS fetch HOST share a host on real AWS but not locally — Floci stamps `iss`
// host-facing, and "localhost" does not resolve to Floci from inside a Lambda
// container. Fetching from the issuer dies with a bare "fetch failed",
// whatever the signature.
// See [[floci-websocket-apigw-dynamodb-support]]
const jwksFetchHost = process.env.AWS_ENDPOINT_URL || new URL(env.issuer).origin;
const jwksUri = `${jwksFetchHost}${new URL(env.issuer).pathname}/.well-known/jwks.json`;

const jwksCache: JwksCache = new SimpleJwksCache(
  process.env.AWS_ENDPOINT_URL ? { fetcher: new LocalHttpJsonFetcher() } : {},
);

// The verifier caches the pool's JWKS (via jwksCache above), so it is built
// once per container and reused across invocations — building it per call
// would fetch the JWKS on every connection.
let verifier: ReturnType<typeof JwtRsaVerifier.create> | null = null;

function getVerifier() {
  if (verifier === null) {
    verifier = JwtRsaVerifier.create(
      {
        issuer: env.issuer,
        jwksUri,
        // `audience: null` — deliberately not checked here. Cognito ACCESS
        // tokens carry `client_id`, not `aud` (only ID tokens have `aud`), so
        // JwtRsaVerifier's own `audience` check does not apply to them.
        // `validateCognitoJwtFields` below re-implements the correct
        // access-token-aware check instead.
        audience: null,
        customJwtCheck: ({ payload }) => {
          validateCognitoJwtFields(payload, {
            tokenUse: "access",
            clientId: env.clientId,
          });
        },
      },
      { jwksCache },
    );
  }
  return verifier;
}

/**
 * Verify a Cognito access token and return its subject. Throws on ANY failure.
 * WARNING: Callers must treat a rejection as Deny and never tell the client
 * WHICH check failed — that hands an unauthenticated caller a probing oracle.
 */
export async function verifyCognitoToken(token: string): Promise<{ sub: string }> {
  if (!token) {
    throw new Error("missing token");
  }
  const payload = await getVerifier().verify(token);
  return { sub: String(payload.sub) };
}
