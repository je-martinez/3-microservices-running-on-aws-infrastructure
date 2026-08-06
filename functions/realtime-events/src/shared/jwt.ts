import { JwtRsaVerifier } from "aws-jwt-verify";
import { validateCognitoJwtFields } from "aws-jwt-verify/cognito-verifier";
import { SimpleJwksCache, type JwksCache } from "aws-jwt-verify/jwk";
import type { JsonFetcher } from "aws-jwt-verify/https";
import { getEnv } from "#shared/config/env";

// Why NOT the top-level `CognitoJwtVerifier`: it derives BOTH `issuer` and
// `jwksUri` purely from `userPoolId`, unconditionally pointed at real AWS
// Cognito (`node_modules/aws-jwt-verify/dist/esm/cognito-verifier.js`:
// `CognitoJwtVerifier.parseUserPoolId()`'s result is spread LAST over
// whatever properties are passed in, so it silently overwrites any
// issuer/jwksUri override — there is no supported way to point it at a
// different issuer). Floci's local user pool only ever exists in Floci, so
// that derivation can never produce a fetchable JWKS for it, and every
// token — valid or garbage — fails verification identically.
//
// This uses the library's own documented escape hatch instead (README,
// "Verifying Cognito JWTs, with a generic JwtRsaVerifier"): the low-level
// `JwtRsaVerifier`, given an explicit `issuer`/`jwksUri` from CONFIGURATION
// (see env.ts's `issuer`, sourced from Terraform's `module.cognito.issuer`
// output — the same value the REST API Gateway's native JWT authorizer
// already consumes), plus `validateCognitoJwtFields` in `customJwtCheck` to
// keep the same tokenUse/clientId checks `CognitoJwtVerifier` itself applies
// (Cognito access tokens carry `client_id`, not `aud` — only ID tokens do;
// `validateCognitoJwtFields` handles that difference).
const env = getEnv();

// aws-jwt-verify's default `SimpleJsonFetcher` calls Node's `https` module
// directly (`https-node.js`: `import { request } from "https"`), which
// throws `Protocol "http:" not supported` for a plain-HTTP JWKS URI —
// verified empirically against Floci's local JWKS endpoint. Floci serves
// that endpoint over plain HTTP (no TLS termination locally), so a custom
// fetcher is required to reach it at all. Built on Node's global `fetch`
// (available unconditionally on the nodejs20.x+ Lambda runtime this package
// targets — no new dependency), which has no such scheme restriction.
//
// Scoped to AWS_ENDPOINT_URL being set (the same signal every other local/prod
// branch in this package uses, e.g. connections-repository.ts's
// dynamoEndpoint): production keeps the library's default HTTPS-only
// fetcher untouched, so nothing about the real-AWS path changes.
class LocalHttpJsonFetcher implements JsonFetcher {
  async fetch<ResultType>(uri: string): Promise<ResultType> {
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error(`JWKS fetch failed: ${uri} -> HTTP ${response.status}`);
    }
    return (await response.json()) as ResultType;
  }
}

// `issuer` (the CLAIM to verify `iss` against) and the JWKS FETCH URL are two
// different concerns that happen to share a host in the real-AWS case, but
// NOT locally: Floci stamps `iss` as the HOST-facing
// "http://localhost:4566/<pool-id>" (what env.issuer holds, verified against
// the token's own payload), while "localhost" does not resolve to Floci from
// inside a Lambda container — only the IN-NETWORK "http://floci:4566" does
// (AWS_ENDPOINT_URL, the same var every other module in this package uses
// for the identical reason). Conflating the two — fetching FROM env.issuer —
// produces exactly the failure this fix exists to close: a plain `fetch`
// against "localhost:4566" from inside the container never even reaches
// Floci ("fetch failed", confirmed via a temporary diagnostic log during
// development), independent of whether the issuer/signature themselves are
// valid.
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
