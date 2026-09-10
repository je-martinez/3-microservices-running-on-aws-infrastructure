// One Lambda serving all three CUSTOM_AUTH challenge triggers, dispatched on
// event.triggerSource. The code lives in Cognito's challenge session
// (privateChallengeParameters) and dies with it — no DB table.
//
// CONTRACT: ZERO dependencies, the AWS SDK included. A bare ESM import of
// `@aws-sdk/client-sqs` resolves only when NODE_PATH=/var/runtime/node_modules
// is set, which the runtime image leaves empty and Floci may not set — so
// SendMessage is a plain signed HTTPS request built from node:crypto and fetch.
// That also keeps the deployment package a single file, no node_modules in the
// zip. See [[cognito-pre-token-lambda]]
import { createHmac, createHash, randomInt, timingSafeEqual } from "node:crypto";

const CODE_LENGTH = Number(process.env.OTP_CODE_LENGTH ?? "6");
const CODE_TTL_SECONDS = Number(process.env.OTP_CODE_TTL_SECONDS ?? "300");

// Cognito stops calling DefineAuthChallenge once it has been told to fail, so
// this bounds how many wrong codes a caller may submit within ONE session. It
// is not a rate limit across sessions — that belongs to the Users service.
const MAX_ATTEMPTS = 3;

const EVENT_TYPE = "AUTH_OTP_REQUESTED";
const EVENT_SOURCE = "users";
// Matches the producer→pipeline contract's `<source>:<action>` AuditActor
// format. The originator here is the Cognito trigger, not a human, so
// author.user_id/cognito_sub are set from the authenticating user below only
// because on this event the subject and the originator are the same person.
const EVENT_ACTOR = "users_api:otp_challenge";

// ─── SigV4-signed SQS SendMessage (no SDK) ───────────────────────────────────
// Uses the SQS JSON protocol (X-Amz-Target: AmazonSQS.SendMessage), verified
// working against Floci. Credentials come from the Lambda execution role via
// the standard env vars the runtime injects.
const SERVICE = "sqs";

function hmac(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function signingKey(secretKey, dateStamp, region) {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

// Minimal SigV4 for a single POST with a fixed, known set of headers — not a
// general-purpose signer. Header names are lowercase and already sorted, so no
// canonicalization pass is needed beyond joining them.
function signedHeaders({ url, body, region, credentials, target }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const { host } = new URL(url);
  const payloadHash = sha256Hex(body);

  const headers = {
    "content-type": "application/x-amz-json-1.0",
    host,
    "x-amz-date": amzDate,
    "x-amz-target": target,
  };
  if (credentials.sessionToken) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaderList = names.join(";");

  const canonicalRequest = [
    "POST",
    new URL(url).pathname || "/",
    "",
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = createHmac(
    "sha256",
    signingKey(credentials.secretAccessKey, dateStamp, region),
  )
    .update(stringToSign, "utf8")
    .digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaderList}, Signature=${signature}`;

  return headers;
}

async function sendMessage({ queueUrl, body, messageAttributes }) {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };

  // AWS_ENDPOINT_URL points at Floci locally (http://floci:4566, the in-network
  // name). Unset in production, where the queue URL's own origin is the real
  // SQS endpoint.
  const endpoint = process.env.AWS_ENDPOINT_URL || new URL(queueUrl).origin;
  const payload = JSON.stringify({
    QueueUrl: queueUrl,
    MessageBody: body,
    MessageAttributes: messageAttributes,
  });

  const target = "AmazonSQS.SendMessage";
  const headers = signedHeaders({
    url: endpoint,
    body: payload,
    region,
    credentials,
    target,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: payload,
  });

  if (!response.ok) {
    // The response text is an SQS error document; it never contains the OTP
    // code (the code travels in the request body only), so it is safe to
    // surface for diagnosis.
    throw new Error(
      `sqs SendMessage failed: ${response.status} ${await response.text()}`,
    );
  }
}

// ─── OTP helpers ─────────────────────────────────────────────────────────────
function generateCode() {
  // randomInt is CSPRNG-backed; Math.random is NOT and must never be used for
  // an authentication secret. Numeric-only, zero-padded to CODE_LENGTH digits
  // (e.g. "042817") so every code has the same length — which the
  // constant-time comparison below also depends on to be meaningful.
  const max = 10 ** CODE_LENGTH;
  return String(randomInt(0, max)).padStart(CODE_LENGTH, "0");
}

function constantTimeEquals(expected, submitted) {
  const bufA = Buffer.from(String(expected), "utf8");
  const bufB = Buffer.from(String(submitted), "utf8");
  // timingSafeEqual THROWS on a length mismatch rather than returning false, so
  // the length is checked first. That check is itself non-constant-time, but it
  // only reveals the code's length, which is a published constant (6) — not a
  // secret. The digits themselves are compared in constant time.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// The cross-service `email_hash` contract: sha256 of the lowercased, trimmed
// address. Reimplemented here (rather than imported) because this Lambda has no
// dependency on the services' shared packages — it is a standalone zip.
function hashEmail(email) {
  return createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex");
}

// CONTRACT: OTel severity numbers, identical to every other producer's table so
// a line from this Lambda and one from a service are indistinguishable.
const SEVERITY_NUMBER = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21 };

// WARNING: The OTP code is NEVER a field here — not masked, not hashed, not
// truncated. A 6-digit code has 1,000,000 possibilities, so no partial reveal is
// safe; `challenge_id` is the correlator.
// CONTRACT: Emit `severity_text`/`severity_number`, not `level` — the collector
// promotes only the shared schema's field names, and anything else reaches
// OpenObserve at severity 0 (UNSPECIFIED). Severity is a call-site decision, and
// `service_name` is stamped here because dashboards group by it.
// See [[logging-context]]
function log(fields, severity = "INFO") {
  const line = {
    severity_text: severity,
    severity_number: SEVERITY_NUMBER[severity] ?? SEVERITY_NUMBER.INFO,
    service_name: "cognito-otp-challenge",
    timestamp: new Date().toISOString(),
    ...fields,
  };
  for (const key of Object.keys(line)) {
    if (line[key] === undefined) delete line[key];
  }
  console.log(JSON.stringify(line));
}

async function publishOtpRequested(event, code, challengeId) {
  const queueUrl = process.env.EVENTS_QUEUE_URL;
  const email = event.request.userAttributes.email;
  const sub = event.request.userAttributes.sub;
  const safeRunId = safeRunIdFrom(event);

  // CONTRACT: Fall back to "", never undefined or an omitted key. The pipeline's
  // schema requires every payload field, and JSON.stringify drops undefined — a
  // missing name would get the whole envelope rejected and cost the user their
  // login code, not just the greeting. Absence is the normal case: the pool
  // populates no name attribute today.
  const fullName = event.request.userAttributes.name ?? "";

  // CONTRACT: snake_case throughout — the wire contract the pipeline's
  // EnvelopeSchema validates. `order_id` is NULLABLE, not optional: the key must
  // be present with a null value or the envelope is rejected.
  const envelope = {
    event_id: `evt_${challengeId}`,
    type: EVENT_TYPE,
    source: EVENT_SOURCE,
    user_id: sub,
    order_id: null,
    // WHO originated the event. On this event the originator and the subject
    // are the same person (the user requesting their own code), so the ids are
    // filled; they are omitted, never null, when that is not the case.
    author: { actor: EVENT_ACTOR, user_id: sub, cognito_sub: sub },
    // WARNING: `code` travels only here, in the SQS body. It is NEVER logged,
    // and the pipeline redacts it before persisting this payload.
    payload: { email, full_name: fullName, code, ttlSeconds: CODE_TTL_SECONDS },
    // CONTRACT: Spread-or-nothing, never null or "". EnvelopeSchema declares
    // run_id optional with `.min(1)`, so either fails validation as a
    // PermanentError — the record dropped and the login code never sent.
    // E2E only; absent in production traffic.
    ...(safeRunId ? { run_id: safeRunId } : {}),
  };

  await sendMessage({
    queueUrl,
    body: JSON.stringify(envelope),
    // Duplicated as message attributes so the queue can be inspected (and
    // filtered) without deserializing the body — same as SqsEventPublisher in
    // services/users/src/shared/messaging/event-publisher.ts.
    messageAttributes: {
      type: { DataType: "String", StringValue: envelope.type },
      source: { DataType: "String", StringValue: envelope.source },
      // Same attribute the other three publishers set, so the pipeline's
      // `originSpanContext` reads this message exactly like theirs. Spread, so
      // a caller that sent no usable traceparent adds no key at all.
      ...traceparentAttribute(event),
    },
  });
}

// The W3C traceparent this trigger forwards onto the SQS message, or undefined.
//
// CONTRACT: It arrives in ClientMetadata, not from an SDK — Cognito invokes this
// trigger so no request context reaches it, and it carries no propagator.
// CONTRACT: Shape-check it, do NOT merely test for truthiness. A bad header
// yields nothing at the consumer anyway, so forwarding one only puts something
// on the wire that LOOKS like real context. See [[logging-context]]
const TRACEPARENT_RE = /^00-(?![0]{32}$)[0-9a-f]{32}-(?![0]{16}$)[0-9a-f]{16}-[0-9a-f]{2}$/;

// WARNING: Shape-check this — it arrives in a caller-controlled field and lands
// in a database document as the key the fixture collection is queried by.
// CONTRACT: Reject an over-long id, never truncate it. A truncated id is a
// valid-LOOKING id that silently matches nothing, so the emails land under a key
// no spec queries and the failure reads as "the pipeline never sent it".
const RUN_ID_RE = /^run_[A-Za-z0-9_:.-]{1,64}$/;

function safeRunIdFrom(event) {
  const runId = event?.request?.clientMetadata?.runId;
  return typeof runId === "string" && RUN_ID_RE.test(runId) ? runId : undefined;
}

function traceparentAttribute(event) {
  const traceparent = event?.request?.clientMetadata?.traceparent;
  if (typeof traceparent !== "string" || !TRACEPARENT_RE.test(traceparent)) return {};

  // Returned as a spreadable object so the caller can add it WITHOUT ever
  // producing a `traceparent` key holding undefined: SQS rejects a message
  // attribute with an empty or missing StringValue, and that failure would cost
  // the user their login code over a telemetry field.
  return { traceparent: { DataType: "String", StringValue: traceparent } };
}

// ─── Trigger handlers ────────────────────────────────────────────────────────
function handleDefineAuthChallenge(event) {
  const sessions = event.request.session ?? [];
  const last = sessions[sessions.length - 1];

  // Succeeded: the previous challenge was answered correctly.
  if (last && last.challengeResult === true) {
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
    return event;
  }

  const attempts = sessions.filter(
    (s) => s.challengeName === "CUSTOM_CHALLENGE",
  ).length;

  // Exhausted: fail rather than issuing a fourth challenge.
  if (attempts >= MAX_ATTEMPTS) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
    return event;
  }

  // First attempt, or a retry with attempts remaining.
  event.response.issueTokens = false;
  event.response.failAuthentication = false;
  event.response.challengeName = "CUSTOM_CHALLENGE";
  return event;
}

async function handleCreateAuthChallenge(event) {
  // A retry within the same session (a second CUSTOM_CHALLENGE round) must NOT
  // mint a new code — that would invalidate the one already emailed while the
  // user is typing it. Reuse it from the previous round's challengeMetadata,
  // which Cognito round-trips back in the session array.
  const sessions = event.request.session ?? [];
  const previous = sessions[sessions.length - 1];

  let code;
  let reused = false;
  if (previous?.challengeMetadata) {
    try {
      code = JSON.parse(previous.challengeMetadata).code;
      reused = typeof code === "string" && code.length > 0;
    } catch {
      // Unparseable metadata is treated as absent — mint a fresh code rather
      // than failing the whole auth flow on a malformed session entry.
      reused = false;
    }
  }
  if (!reused) code = generateCode();

  const challengeId = `otp_${event.request.userAttributes.sub}_${Date.now()}`;

  // Email only on the round that actually created the code. A reused code was
  // already sent; mailing it again on every retry would be a send amplifier.
  if (!reused) {
    await publishOtpRequested(event, code, challengeId);
    log({
      app_event: "otp_challenge_created",
      email_hash: hashEmail(event.request.userAttributes.email),
      cognito_sub: event.request.userAttributes.sub,
      challenge_id: challengeId,
      ttl_seconds: CODE_TTL_SECONDS,
    });
  }

  // publicChallengeParameters is RETURNED TO THE CLIENT — the code must never
  // appear here. Only privateChallengeParameters stays server-side.
  event.response.publicChallengeParameters = { deliveryMedium: "EMAIL" };
  event.response.privateChallengeParameters = { code };
  // Round-trips the code to the NEXT invocation's `session` array so a
  // same-session retry reuses it (see the reuse branch above).
  event.response.challengeMetadata = JSON.stringify({ code });
  return event;
}

function handleVerifyAuthChallengeResponse(event) {
  const expected = event.request.privateChallengeParameters?.code;
  const submitted = event.request.challengeAnswer;

  // A missing expected code can never be "matched" — guard before comparing so
  // an absent/undefined pair does not compare equal.
  event.response.answerCorrect =
    typeof expected === "string" &&
    expected.length > 0 &&
    constantTimeEquals(expected, submitted);

  // A rejected code is a WARN, not an INFO. It is the line someone looks for
  // when investigating a login someone could not complete — or a brute-force
  // attempt — and at INFO it was indistinguishable from a success in every
  // severity filter and every dashboard.
  log(
    {
      app_event: event.response.answerCorrect
        ? "otp_challenge_verified"
        : "otp_challenge_rejected",
      email_hash: event.request.userAttributes?.email
        ? hashEmail(event.request.userAttributes.email)
        : undefined,
      cognito_sub: event.request.userAttributes?.sub,
      reason: event.response.answerCorrect ? undefined : "code_mismatch",
    },
    event.response.answerCorrect ? "INFO" : "WARN",
  );

  return event;
}

export const handler = async (event) => {
  switch (event.triggerSource) {
    case "DefineAuthChallenge_Authentication":
      return handleDefineAuthChallenge(event);
    case "CreateAuthChallenge_Authentication":
      return handleCreateAuthChallenge(event);
    case "VerifyAuthChallengeResponse_Authentication":
      return handleVerifyAuthChallengeResponse(event);
    default:
      // Unknown trigger source: return the event untouched rather than
      // throwing, so an unrelated trigger accidentally wired here degrades to a
      // no-op instead of breaking that flow.
      return event;
  }
};
