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

  // Same class of silent failure as the `name` attribute above: the Pre-Token
  // Lambda reads ONLY Cognito attributes, so if this one is never written the
  // must_change_password claim is false for every user forever — a forced
  // password change that quietly never gets enforced.
  it("signUp seeds custom:must_change_password to the column's default", async () => {
    const send = vi.fn(async () => ({ User: { Attributes: [{ Name: "sub", Value: "sub-1" }] } }));
    const p = new CognitoAuthProvider({ send } as any, "pool", "client");

    await p.signUp("a@b.co", "P@ss", "usr_ABC", "Ada Lovelace");

    const attrs = send.mock.calls[0][0].input.UserAttributes;
    expect(attrs).toEqual(
      expect.arrayContaining([{ Name: "custom:must_change_password", Value: "false" }]),
    );
  });

  // Cognito has no boolean attribute type — the Lambda compares against the
  // STRING "true", so a value written as anything else reads as false there.
  it("setMustChangePassword writes the flag as a Cognito string attribute", async () => {
    const send = vi.fn(async () => ({}));
    const p = new CognitoAuthProvider({ send } as any, "pool", "client");

    await p.setMustChangePassword("a@b.co", true);

    const { input } = send.mock.calls[0][0];
    expect(input.Username).toBe("a@b.co");
    expect(input.UserAttributes).toEqual([
      { Name: "custom:must_change_password", Value: "true" },
    ]);
  });

  it("setMustChangePassword writes \"false\" when clearing the flag", async () => {
    const send = vi.fn(async () => ({}));
    const p = new CognitoAuthProvider({ send } as any, "pool", "client");

    await p.setMustChangePassword("a@b.co", false);

    expect(send.mock.calls[0][0].input.UserAttributes).toEqual([
      { Name: "custom:must_change_password", Value: "false" },
    ]);
  });

  it("setMustChangePassword maps UserNotFoundException to InvalidCredentialsError", async () => {
    const client = {
      send: vi.fn(async () => {
        const e: any = new Error("User not found");
        e.name = "UserNotFoundException";
        throw e;
      }),
    };
    const p = new CognitoAuthProvider(client as any, "pool", "client");
    await expect(p.setMustChangePassword("nobody@x.co", false)).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
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
