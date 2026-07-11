import { describe, it, expect } from "vitest";
import {
  RegisterInputSchema, LoginInputSchema, UpdateProfileInputSchema,
  UserSchema, AuthTokensSchema, ErrorSchema, UserIdHeader,
} from "#features/users/http/schemas";

describe("http schemas", () => {
  it("RegisterInputSchema requires email/password/fullName, allows optional address/phoneNumber", () => {
    expect(RegisterInputSchema.safeParse({ email: "a@b.co", password: "P!1", fullName: "A" }).success).toBe(true);
    expect(RegisterInputSchema.safeParse({ email: "a@b.co" }).success).toBe(false);
  });

  it("LoginInputSchema requires email + password", () => {
    expect(LoginInputSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
    expect(LoginInputSchema.safeParse({ email: "a@b.co" }).success).toBe(false);
  });

  it("UpdateProfileInputSchema accepts an empty object (all optional)", () => {
    expect(UpdateProfileInputSchema.safeParse({}).success).toBe(true);
  });

  it("AuthTokensSchema requires the three tokens", () => {
    expect(AuthTokensSchema.safeParse({ idToken: "i", accessToken: "a", refreshToken: "r" }).success).toBe(true);
    expect(AuthTokensSchema.safeParse({ idToken: "i" }).success).toBe(false);
  });

  it("UserSchema parses a full user row shape", () => {
    const u = {
      id: "usr_x", email: "a@b.co", fullName: "A", address: null, phoneNumber: null,
      tags: [], createdBy: null, createdAt: "2026-07-10T00:00:00.000Z",
      updatedBy: null, updatedAt: "2026-07-10T00:00:00.000Z",
      deletedBy: null, deletedAt: null, isDeleted: false,
    };
    expect(UserSchema.safeParse(u).success).toBe(true);
  });

  it("UserIdHeader validates x-user-id and ErrorSchema an error string", () => {
    expect(UserIdHeader.safeParse({ "x-user-id": "usr_1" }).success).toBe(true);
    expect(ErrorSchema.safeParse({ error: "not_found" }).success).toBe(true);
  });
});
