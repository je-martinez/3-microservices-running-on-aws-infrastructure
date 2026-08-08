import { describe, it, expect, vi } from "vitest";
import { CognitoAuthProvider } from "#shared/auth/cognito-auth-provider";
import { InvalidCredentialsError, EmailAlreadyExistsError } from "#shared/auth/auth-errors";

describe("CognitoAuthProvider", () => {
  it("login maps Cognito tokens to the AuthProvider shape", async () => {
    const fakeClient = {
      send: vi.fn().mockResolvedValue({
        AuthenticationResult: { IdToken: "id", AccessToken: "acc", RefreshToken: "ref" },
      }),
    };
    const provider = new CognitoAuthProvider(fakeClient as any, "pool", "client");
    const tokens = await provider.login("a@b.c", "Passw0rd!");
    expect(tokens).toEqual({ idToken: "id", accessToken: "acc", refreshToken: "ref" });
  });

  it("login maps UserNotFoundException to InvalidCredentialsError (401)", async () => {
    const client = {
      send: vi.fn(async () => {
        const e: any = new Error("User not found");
        e.name = "UserNotFoundException";
        throw e;
      }),
    };
    const p = new CognitoAuthProvider(client as any, "pool", "client");
    await expect(p.login("nobody@x.co", "bad")).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("login maps NotAuthorizedException to InvalidCredentialsError (401)", async () => {
    const client = {
      send: vi.fn(async () => {
        const e: any = new Error("Incorrect username or password");
        e.name = "NotAuthorizedException";
        throw e;
      }),
    };
    const p = new CognitoAuthProvider(client as any, "pool", "client");
    await expect(p.login("a@b.co", "wrong")).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("login rethrows unexpected errors unchanged", async () => {
    const boom = new Error("kaboom");
    const client = {
      send: vi.fn(async () => {
        throw boom;
      }),
    };
    const p = new CognitoAuthProvider(client as any, "pool", "client");
    await expect(p.login("a@b.co", "x")).rejects.toBe(boom);
  });

  it("signUp maps UsernameExistsException to EmailAlreadyExistsError (409)", async () => {
    const client = {
      send: vi.fn(async () => {
        const e: any = new Error("User already exists");
        e.name = "UsernameExistsException";
        throw e;
      }),
    };
    const p = new CognitoAuthProvider(client as any, "pool", "client");
    await expect(p.signUp("dup@x.co", "P@ss", "usr_X")).rejects.toBeInstanceOf(EmailAlreadyExistsError);
  });

  it("signUp sets custom:app_user_id from the app user id", async () => {
    const send = vi.fn(async () => ({ User: { Attributes: [{ Name: "sub", Value: "sub-1" }] } }));
    const p = new CognitoAuthProvider({ send } as any, "pool", "client");
    await p.signUp("a@b.co", "P@ss", "usr_ABC", "Ada Lovelace");
    const createCall = send.mock.calls[0][0]; // AdminCreateUserCommand
    const attrs = createCall.input.UserAttributes;
    expect(attrs).toEqual(expect.arrayContaining([{ Name: "custom:app_user_id", Value: "usr_ABC" }]));
  });

  // Cognito is the ONLY place the OTP challenge Lambda can read a user from: it
  // runs inside Cognito with no SDK and no database, so an attribute missing
  // here is a greeting the login-code email can never recover. That failure is
  // silent — the email still sends, still looks right, and simply says "Hello,"
  // to everyone — which is exactly how it went unnoticed until the delivered
  // messages were read. This pins the attribute so it cannot be dropped again.
  it("signUp writes the full name to Cognito's standard `name` attribute", async () => {
    const send = vi.fn(async () => ({ User: { Attributes: [{ Name: "sub", Value: "sub-1" }] } }));
    const p = new CognitoAuthProvider({ send } as any, "pool", "client");

    await p.signUp("a@b.co", "P@ss", "usr_ABC", "Ada Lovelace");

    const attrs = send.mock.calls[0][0].input.UserAttributes;
    expect(attrs).toEqual(expect.arrayContaining([{ Name: "name", Value: "Ada Lovelace" }]));
  });

  it("refresh returns new id + access tokens", async () => {
    const client = { send: vi.fn(async () => ({ AuthenticationResult: { IdToken: "id2", AccessToken: "acc2" } })) };
    const p = new CognitoAuthProvider(client as any, "pool", "client");
    await expect(p.refresh("rt")).resolves.toEqual({ idToken: "id2", accessToken: "acc2" });
  });

  it("refresh maps NotAuthorizedException to InvalidCredentialsError (401)", async () => {
    const client = {
      send: vi.fn(async () => {
        const e: any = new Error("Invalid Refresh Token");
        e.name = "NotAuthorizedException";
        throw e;
      }),
    };
    const p = new CognitoAuthProvider(client as any, "pool", "client");
    await expect(p.refresh("bad")).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("refresh rethrows unexpected errors", async () => {
    const boom = new Error("kaboom");
    const client = {
      send: vi.fn(async () => {
        throw boom;
      }),
    };
    const p = new CognitoAuthProvider(client as any, "pool", "client");
    await expect(p.refresh("rt")).rejects.toBe(boom);
  });
});
