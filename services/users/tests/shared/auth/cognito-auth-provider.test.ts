import { describe, it, expect, vi } from "vitest";
import { context, trace } from "@opentelemetry/api";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  GlobalSignOutCommand,
  RespondToAuthChallengeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CognitoAuthProvider } from "#shared/auth/cognito-auth-provider";
import {
  EmailAlreadyExistsError,
  InvalidCredentialsError,
  InvalidOtpError,
} from "#shared/auth/auth-errors";
import { logContext } from "#shared/logging/log-context";

const POOL = "us-east-1_pool";
const CLIENT = "client-id";

type Send = ReturnType<typeof vi.fn<(command: any) => Promise<any>>>;

function providerWith(send: Send): CognitoAuthProvider {
  return new CognitoAuthProvider({ send } as never, POOL, CLIENT);
}

function cognitoError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

function rejectingWith(error: Error): Send {
  return vi.fn(async () => {
    throw error;
  });
}

const CREATED = { User: { Attributes: [{ Name: "sub", Value: "sub-1" }] } };

describe("CognitoAuthProvider.signUp", () => {
  async function createAttributes(): Promise<Array<{ Name: string; Value: string }>> {
    const send: Send = vi.fn(async () => CREATED);
    await providerWith(send).signUp("a@b.co", "P@ss", "usr_ABC", "Ada Lovelace");
    const created = send.mock.calls[0]![0];
    expect(created).toBeInstanceOf(AdminCreateUserCommand);
    return created.input.UserAttributes;
  }

  it("sets custom:app_user_id from the app user id", async () => {
    expect(await createAttributes()).toEqual(
      expect.arrayContaining([{ Name: "custom:app_user_id", Value: "usr_ABC" }]),
    );
  });

  // CONTRACT: The OTP challenge Lambda reads ONLY Cognito attributes. Dropping `name`
  // still sends the login-code email, greeting everyone with a bare "Hello,".
  it("writes the full name to Cognito's standard `name` attribute", async () => {
    expect(await createAttributes()).toEqual(
      expect.arrayContaining([{ Name: "name", Value: "Ada Lovelace" }]),
    );
  });

  // CONTRACT: The Pre-Token Lambda reads ONLY Cognito attributes. Without this seed
  // the must_change_password claim is false for every user and a forced change is
  // never enforced.
  it("seeds custom:must_change_password to the column's default", async () => {
    expect(await createAttributes()).toEqual(
      expect.arrayContaining([{ Name: "custom:must_change_password", Value: "false" }]),
    );
  });

  it("sets the password as permanent and returns the Cognito identity", async () => {
    const send: Send = vi.fn(async () => CREATED);

    const result = await providerWith(send).signUp("a@b.co", "P@ss", "usr_ABC", "Ada");

    const setPassword = send.mock.calls[1]![0];
    expect(setPassword).toBeInstanceOf(AdminSetUserPasswordCommand);
    expect(setPassword.input).toEqual({
      UserPoolId: POOL,
      Username: "a@b.co",
      Password: "P@ss",
      Permanent: true,
    });
    expect(result).toEqual({
      sub: "sub-1",
      email: "a@b.co",
      emailVerified: undefined,
      userPoolId: POOL,
      clientId: CLIENT,
    });
  });

  it("maps UsernameExistsException to EmailAlreadyExistsError (409)", async () => {
    const send = rejectingWith(cognitoError("UsernameExistsException"));
    await expect(providerWith(send).signUp("dup@x.co", "P@ss", "usr_X", "Ada")).rejects.toBeInstanceOf(
      EmailAlreadyExistsError,
    );
  });

  // CONTRACT: No fallback to the email when Cognito omits the sub — the email would
  // hash into the idempotency key as if it were one.
  it("throws when Cognito returns no sub", async () => {
    const send: Send = vi.fn(async () => ({ User: { Attributes: [] } }));
    await expect(providerWith(send).signUp("a@b.co", "P@ss", "usr_X", "Ada")).rejects.toThrow(
      /returned no sub/,
    );
  });
});

describe("CognitoAuthProvider.login", () => {
  it("maps Cognito tokens to the AuthProvider shape", async () => {
    const send: Send = vi.fn(async () => ({
      AuthenticationResult: { IdToken: "id", AccessToken: "acc", RefreshToken: "ref" },
    }));

    const tokens = await providerWith(send).login("a@b.c", "Passw0rd!");

    expect(tokens).toEqual({ idToken: "id", accessToken: "acc", refreshToken: "ref" });
    const sent = send.mock.calls[0]![0];
    expect(sent).toBeInstanceOf(AdminInitiateAuthCommand);
    expect(sent.input.AuthFlow).toBe("ADMIN_USER_PASSWORD_AUTH");
  });

  it.each(["UserNotFoundException", "NotAuthorizedException"])(
    "maps %s to InvalidCredentialsError (401)",
    async (name) => {
      const send = rejectingWith(cognitoError(name));
      await expect(providerWith(send).login("a@b.co", "bad")).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    },
  );

  it("rethrows unexpected errors unchanged", async () => {
    const boom = new Error("kaboom");
    await expect(providerWith(rejectingWith(boom)).login("a@b.co", "x")).rejects.toBe(boom);
  });
});

// CONTRACT: ClientMetadata is the only channel to the CUSTOM_AUTH trigger, which
// publishes the OTP email. Without the traceparent the email's pipeline work lands
// in a trace of its own. The suite's tracer provider is the one tests/setup.ts
// registers — a no-op default would make `propagation.inject` write nothing.
describe("CognitoAuthProvider.startOtpChallenge — trace propagation", () => {
  it("uses CUSTOM_AUTH, never the native email-OTP flow", async () => {
    const send: Send = vi.fn(async () => ({ Session: "sess_1" }));

    await expect(providerWith(send).startOtpChallenge("ada@example.com")).resolves.toEqual({
      session: "sess_1",
    });

    const sent = send.mock.calls[0]![0];
    expect(sent).toBeInstanceOf(AdminInitiateAuthCommand);
    expect(sent.input.AuthFlow).toBe("CUSTOM_AUTH");
  });

  it("passes the active span's traceparent to the trigger via ClientMetadata", async () => {
    const send: Send = vi.fn(async () => ({ Session: "sess_1" }));
    const span = trace.getTracer("test").startSpan("otp_challenge");

    await context.with(trace.setSpan(context.active(), span), () =>
      providerWith(send).startOtpChallenge("ada@example.com"),
    );
    span.end();

    const { ClientMetadata } = send.mock.calls[0]![0].input;
    expect(ClientMetadata.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    // A well-formed traceparent naming another span would attach the email to an
    // unrelated request.
    expect(ClientMetadata.traceparent).toContain(span.spanContext().traceId);
  });

  it("omits ClientMetadata entirely when there is no span and no run id", async () => {
    const send: Send = vi.fn(async () => ({ Session: "sess_1" }));

    await providerWith(send).startOtpChallenge("ada@example.com");

    expect(send.mock.calls[0]![0].input.ClientMetadata).toBeUndefined();
  });

  it("maps UserNotFoundException to InvalidCredentialsError", async () => {
    const send = rejectingWith(cognitoError("UserNotFoundException"));
    await expect(providerWith(send).startOtpChallenge("nobody@x.co")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("throws when Cognito returns no session", async () => {
    const send: Send = vi.fn(async () => ({}));
    await expect(providerWith(send).startOtpChallenge("ada@example.com")).rejects.toThrow(
      /returned no session/,
    );
  });
});

// CONTRACT: The run id is independent of the span — an E2E stack with tracing off
// must still carry it, or every OTP email lands unattributed.
describe("CognitoAuthProvider.startOtpChallenge — run id propagation", () => {
  it("passes the active run id to the trigger even when no span is active", async () => {
    const send: Send = vi.fn(async () => ({ Session: "sess_1" }));

    await logContext.run({ run_id: "run_abc" }, () =>
      providerWith(send).startOtpChallenge("ada@example.com"),
    );

    const { ClientMetadata } = send.mock.calls[0]![0].input;
    expect(ClientMetadata.runId).toBe("run_abc");
    expect(ClientMetadata.traceparent).toBeUndefined();
  });

  it("omits runId when the context has none, rather than sending a blank one", async () => {
    const send: Send = vi.fn(async () => ({ Session: "sess_1" }));
    const span = trace.getTracer("test").startSpan("otp_challenge");

    await context.with(trace.setSpan(context.active(), span), () =>
      logContext.run({}, () => providerWith(send).startOtpChallenge("ada@example.com")),
    );
    span.end();

    expect(send.mock.calls[0]![0].input.ClientMetadata).not.toHaveProperty("runId");
  });
});

describe("CognitoAuthProvider.respondToOtpChallenge", () => {
  // WHY: RespondToAuthChallenge is the non-admin call — a UserPoolId in the input
  // means an Admin* operation was swapped in.
  it("sends the code with ClientId and no UserPoolId, and returns the tokens", async () => {
    const send: Send = vi.fn(async () => ({
      AuthenticationResult: { IdToken: "id", AccessToken: "acc", RefreshToken: "ref" },
    }));

    const tokens = await providerWith(send).respondToOtpChallenge("a@b.co", "sess_1", "123456");

    const sent = send.mock.calls[0]![0];
    expect(sent).toBeInstanceOf(RespondToAuthChallengeCommand);
    expect(sent.input).toEqual({
      ClientId: CLIENT,
      ChallengeName: "CUSTOM_CHALLENGE",
      Session: "sess_1",
      ChallengeResponses: { USERNAME: "a@b.co", ANSWER: "123456" },
    });
    expect(tokens).toEqual({ idToken: "id", accessToken: "acc", refreshToken: "ref" });
  });

  it.each(["NotAuthorizedException", "UserNotFoundException"])(
    "maps %s to InvalidOtpError",
    async (name) => {
      const send = rejectingWith(cognitoError(name));
      await expect(
        providerWith(send).respondToOtpChallenge("a@b.co", "sess_1", "000000"),
      ).rejects.toBeInstanceOf(InvalidOtpError);
    },
  );

  it("treats a further challenge (no tokens) as an invalid code", async () => {
    const send: Send = vi.fn(async () => ({ ChallengeName: "CUSTOM_CHALLENGE", Session: "s2" }));
    await expect(
      providerWith(send).respondToOtpChallenge("a@b.co", "sess_1", "123456"),
    ).rejects.toBeInstanceOf(InvalidOtpError);
  });
});

describe("CognitoAuthProvider.setPassword", () => {
  // CONTRACT: A temporary password puts the account in FORCE_CHANGE_PASSWORD and
  // locks the user out behind a challenge this service cannot answer.
  it("sets the password as permanent", async () => {
    const send: Send = vi.fn(async () => ({}));

    await providerWith(send).setPassword("a@b.co", "N3w!pass");

    const sent = send.mock.calls[0]![0];
    expect(sent).toBeInstanceOf(AdminSetUserPasswordCommand);
    expect(sent.input).toEqual({
      UserPoolId: POOL,
      Username: "a@b.co",
      Password: "N3w!pass",
      Permanent: true,
    });
  });

  it("maps UserNotFoundException to InvalidCredentialsError", async () => {
    const send = rejectingWith(cognitoError("UserNotFoundException"));
    await expect(providerWith(send).setPassword("nobody@x.co", "x")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });
});

describe("CognitoAuthProvider.setMustChangePassword", () => {
  // CONTRACT: Cognito has no boolean attribute type — the Lambda compares against the
  // STRING "true", so any other encoding reads as false there.
  it.each([
    [true, "true"],
    [false, "false"],
  ])("writes %s as the Cognito string attribute %j", async (flag, value) => {
    const send: Send = vi.fn(async () => ({}));

    await providerWith(send).setMustChangePassword("a@b.co", flag);

    const sent = send.mock.calls[0]![0];
    expect(sent).toBeInstanceOf(AdminUpdateUserAttributesCommand);
    expect(sent.input.Username).toBe("a@b.co");
    expect(sent.input.UserAttributes).toEqual([
      { Name: "custom:must_change_password", Value: value },
    ]);
  });

  it("maps UserNotFoundException to InvalidCredentialsError", async () => {
    const send = rejectingWith(cognitoError("UserNotFoundException"));
    await expect(
      providerWith(send).setMustChangePassword("nobody@x.co", false),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });
});

describe("CognitoAuthProvider.deleteUser", () => {
  // CONTRACT: Assert the command TYPE as well as its input. AdminDisableUser with the
  // same input keeps the email occupied in the pool, blocking re-registration.
  it("sends AdminDeleteUserCommand for the given email", async () => {
    const send: Send = vi.fn(async () => ({}));

    await providerWith(send).deleteUser("a@b.co");

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0];
    expect(sent).toBeInstanceOf(AdminDeleteUserCommand);
    expect(sent.input).toEqual({ UserPoolId: POOL, Username: "a@b.co" });
  });

  it("maps UserNotFoundException to InvalidCredentialsError", async () => {
    const send = rejectingWith(cognitoError("UserNotFoundException"));
    await expect(providerWith(send).deleteUser("a@b.co")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  // The caller logs this error to raise the orphaned-pool-entry alert; a wrapped
  // error would lose its name.
  it("rethrows any other error unchanged", async () => {
    const boom = cognitoError("InternalErrorException", "boom");
    await expect(providerWith(rejectingWith(boom)).deleteUser("a@b.co")).rejects.toBe(boom);
  });
});

describe("CognitoAuthProvider.refresh", () => {
  it("returns new id + access tokens via REFRESH_TOKEN_AUTH", async () => {
    const send: Send = vi.fn(async () => ({
      AuthenticationResult: { IdToken: "id2", AccessToken: "acc2" },
    }));

    await expect(providerWith(send).refresh("rt")).resolves.toEqual({
      idToken: "id2",
      accessToken: "acc2",
    });
    expect(send.mock.calls[0]![0].input).toMatchObject({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      AuthParameters: { REFRESH_TOKEN: "rt" },
    });
  });

  it.each(["NotAuthorizedException", "UserNotFoundException"])(
    "maps %s to InvalidCredentialsError (401)",
    async (name) => {
      const send = rejectingWith(cognitoError(name));
      await expect(providerWith(send).refresh("bad")).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
    },
  );

  it("rethrows unexpected errors", async () => {
    const boom = new Error("kaboom");
    await expect(providerWith(rejectingWith(boom)).refresh("rt")).rejects.toBe(boom);
  });
});

describe("CognitoAuthProvider.signOut", () => {
  // GlobalSignOut takes the access token and NOTHING else; a pool or client id in
  // the input means an Admin* operation was swapped in.
  it("sends GlobalSignOut carrying only the access token", async () => {
    const send: Send = vi.fn(async () => ({}));

    await providerWith(send).signOut("access-token");

    const sent = send.mock.calls[0]![0];
    expect(sent).toBeInstanceOf(GlobalSignOutCommand);
    expect(sent.input).toEqual({ AccessToken: "access-token" });
  });

  // CONTRACT: Idempotent — an expired, malformed or already-revoked token means the
  // session is gone. A 401 here fails the second of two sign-out clicks.
  it.each(["NotAuthorizedException", "UserNotFoundException"])(
    "resolves on %s (already signed out)",
    async (name) => {
      const send = rejectingWith(cognitoError(name));
      await expect(providerWith(send).signOut("revoked")).resolves.toBeUndefined();
    },
  );

  // Throttling and outages are not the idempotent case — swallowing them reports a
  // revocation that never happened.
  it("rethrows an unexpected Cognito error", async () => {
    const boom = cognitoError("TooManyRequestsException", "Rate exceeded");
    await expect(providerWith(rejectingWith(boom)).signOut("at")).rejects.toBe(boom);
  });
});
