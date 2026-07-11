import { describe, it, expect } from "vitest";
import { AuthError, InvalidCredentialsError, EmailAlreadyExistsError } from "#shared/auth/auth-errors";

describe("auth errors", () => {
  it("InvalidCredentialsError is 401/invalid_credentials", () => {
    const e = new InvalidCredentialsError();
    expect(e).toBeInstanceOf(AuthError);
    expect(e.statusCode).toBe(401);
    expect(e.code).toBe("invalid_credentials");
    expect(e.name).toBe("InvalidCredentialsError");
  });
  it("EmailAlreadyExistsError is 409/email_exists", () => {
    const e = new EmailAlreadyExistsError();
    expect(e).toBeInstanceOf(AuthError);
    expect(e.statusCode).toBe(409);
    expect(e.code).toBe("email_exists");
  });
});
