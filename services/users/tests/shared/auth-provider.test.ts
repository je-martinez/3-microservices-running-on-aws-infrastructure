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
    await expect(p.signUp("dup@x.co", "P@ss")).rejects.toBeInstanceOf(EmailAlreadyExistsError);
  });
});
