import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Unit tests for the CUSTOM_AUTH challenge Lambda, driven the way Cognito
// actually drives it: through the single exported `handler`, dispatching on
// `event.triggerSource`. The three per-trigger functions are deliberately not
// exported, so testing through the front door is both the only option and the
// more faithful one — it exercises the dispatch as well as the logic.
//
// The SQS publish is stubbed at the fetch boundary: these tests are about the
// challenge state machine and must not require a queue. The publish CONTENT is
// asserted where it matters (that the code leaves via SQS and not via the
// client-facing response).

const QUEUE_URL = "http://localhost:4566/000000000000/events";

// CODE_LENGTH and CODE_TTL_SECONDS are read at MODULE scope in index.mjs, so
// the environment has to be in place before the import is evaluated — hence
// setting it here rather than in beforeEach, and a single static import rather
// than a per-test dynamic one (Vite cannot resolve a dynamic import built from
// a variable, and re-importing would not re-run module initialization anyway).
process.env.EVENTS_QUEUE_URL = QUEUE_URL;
process.env.AWS_REGION = "us-east-1";
process.env.OTP_CODE_LENGTH = "6";
process.env.OTP_CODE_TTL_SECONDS = "300";

const { handler } = await import("./index.mjs");

// Captures what would have been sent to SQS so the envelope can be inspected.
let sentBodies = [];

function defineEvent(sessions = []) {
  return {
    triggerSource: "DefineAuthChallenge_Authentication",
    request: {
      session: sessions,
      userAttributes: { email: "ada@example.com", sub: "sub-123" },
    },
    response: {},
  };
}

function createEvent(sessions = []) {
  return {
    triggerSource: "CreateAuthChallenge_Authentication",
    request: {
      session: sessions,
      userAttributes: { email: "ada@example.com", sub: "sub-123" },
    },
    response: {},
  };
}

function verifyEvent(expectedCode, submitted) {
  return {
    triggerSource: "VerifyAuthChallengeResponse_Authentication",
    request: {
      privateChallengeParameters: { code: expectedCode },
      challengeAnswer: submitted,
      userAttributes: { email: "ada@example.com", sub: "sub-123" },
    },
    response: {},
  };
}

beforeEach(() => {
  sentBodies = [];
  process.env.EVENTS_QUEUE_URL = QUEUE_URL;
  process.env.AWS_REGION = "us-east-1";
  process.env.OTP_CODE_LENGTH = "6";
  process.env.OTP_CODE_TTL_SECONDS = "300";

  // Intercept the SQS call at the transport boundary.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      sentBodies.push(init?.body ?? "");
      return { ok: true, status: 200, text: async () => "" };
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DefineAuthChallenge", () => {
  it("issues a CUSTOM_CHALLENGE on the first attempt", async () => {
    const event = await handler(defineEvent([]));

    expect(event.response.challengeName).toBe("CUSTOM_CHALLENGE");
    expect(event.response.issueTokens).toBe(false);
    expect(event.response.failAuthentication).toBe(false);
  });

  it("issues tokens once a challenge has been answered correctly", async () => {
    const event = await handler(
      defineEvent([{ challengeName: "CUSTOM_CHALLENGE", challengeResult: true }]),
    );

    expect(event.response.issueTokens).toBe(true);
    expect(event.response.failAuthentication).toBe(false);
  });

  // The guard that stops an unbounded guessing loop. Without it a caller could
  // keep answering a 6-digit challenge until they hit it.
  it("fails authentication after three failed attempts instead of issuing a fourth challenge", async () => {
    const threeFailures = [
      { challengeName: "CUSTOM_CHALLENGE", challengeResult: false },
      { challengeName: "CUSTOM_CHALLENGE", challengeResult: false },
      { challengeName: "CUSTOM_CHALLENGE", challengeResult: false },
    ];

    const event = await handler(defineEvent(threeFailures));

    expect(event.response.failAuthentication).toBe(true);
    expect(event.response.issueTokens).toBe(false);
    expect(event.response.challengeName).toBeUndefined();
  });
});

describe("CreateAuthChallenge", () => {
  it("generates a 6-digit code and keeps it out of the client-facing parameters", async () => {
    const event = await handler(createEvent([]));

    const code = event.response.privateChallengeParameters.code;
    expect(code).toMatch(/^\d{6}$/);

    // publicChallengeParameters is returned to the CALLER. A code here would
    // hand the secret to whoever asked for the challenge, defeating the email
    // round-trip entirely.
    expect(JSON.stringify(event.response.publicChallengeParameters)).not.toContain(code);
  });

  it("publishes the code to SQS so the pipeline can email it", async () => {
    const event = await handler(createEvent([]));
    const code = event.response.privateChallengeParameters.code;

    expect(sentBodies).toHaveLength(1);
    // The Lambda speaks the AWS JSON protocol directly (hand-rolled SigV4, no
    // SDK dependency), so the request body is JSON with a MessageBody field —
    // not the form-encoded query protocol.
    const envelope = JSON.parse(JSON.parse(sentBodies[0]).MessageBody);

    expect(envelope.type).toBe("AUTH_OTP_REQUESTED");
    expect(envelope.payload.code).toBe(code);
    // order_id is nullable-but-required in the pipeline's EnvelopeSchema: the
    // KEY must be present, or the envelope is rejected on arrival.
    expect(envelope).toHaveProperty("order_id", null);
    expect(envelope.user_id).toBeTruthy();
    expect(envelope.author.actor).toBeTruthy();
  });

  // A second CUSTOM_CHALLENGE round must not mint a new code: the user is
  // typing the one already in their inbox, and replacing it would invalidate
  // the mail they are looking at.
  it("reuses the existing code on a retry instead of emailing a second one", async () => {
    const first = await handler(createEvent([]));
    const code = first.response.privateChallengeParameters.code;

    const retry = await handler(
      createEvent([
        {
          challengeName: "CUSTOM_CHALLENGE",
          challengeResult: false,
          challengeMetadata: first.response.challengeMetadata,
        },
      ]),
    );

    expect(retry.response.privateChallengeParameters.code).toBe(code);
    // Still one publish in total — the retry sent nothing.
    expect(sentBodies).toHaveLength(1);
  });

  it("never writes the code to the log stream", async () => {
    const event = await handler(createEvent([]));
    const code = event.response.privateChallengeParameters.code;

    const logged = console.log.mock.calls.map((args) => args.join(" ")).join("\n");

    // Serialized comparison, so a code nested anywhere in a structured line is
    // still caught. An OTP has ~1e6 possibilities, so even a partial or hashed
    // form in a log would be brute-forceable while the code is still valid.
    expect(logged).not.toContain(code);
    // The line itself must still exist and be useful for support.
    expect(logged).toContain("otp_challenge_created");
    expect(logged).toContain("challenge_id");
  });
});

describe("VerifyAuthChallengeResponse", () => {
  it("accepts the correct code", async () => {
    const event = await handler(verifyEvent("123456", "123456"));
    expect(event.response.answerCorrect).toBe(true);
  });

  // THE anti-false-PASS guard. Without this assertion the suite cannot tell a
  // working challenge from one that accepts anything — which is exactly what
  // Cognito's native USER_AUTH/EMAIL_OTP does on Floci.
  it("rejects a wrong code", async () => {
    const event = await handler(verifyEvent("123456", "000000"));
    expect(event.response.answerCorrect).toBe(false);
  });

  it("rejects an answer of a different length without throwing", async () => {
    // timingSafeEqual throws on a length mismatch, so this proves the length
    // guard runs before the comparison.
    const event = await handler(verifyEvent("123456", "1234"));
    expect(event.response.answerCorrect).toBe(false);
  });

  it("rejects when no expected code is present rather than matching undefined", async () => {
    const event = await handler({
      triggerSource: "VerifyAuthChallengeResponse_Authentication",
      request: {
        privateChallengeParameters: {},
        challengeAnswer: undefined,
        userAttributes: { email: "ada@example.com", sub: "sub-123" },
      },
      response: {},
    });
    expect(event.response.answerCorrect).toBe(false);
  });
});
