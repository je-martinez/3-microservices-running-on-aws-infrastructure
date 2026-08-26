import { describe, it, expect, vi } from "vitest";
import { AdminDeleteUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { CognitoAuthProvider } from "#shared/auth/cognito-auth-provider";
import { InvalidCredentialsError } from "#shared/auth/auth-errors";

function makeProvider(send: ReturnType<typeof vi.fn>) {
  return new CognitoAuthProvider({ send } as any, "pool-1", "client-1");
}

describe("CognitoAuthProvider.deleteUser", () => {
  it("sends AdminDeleteUserCommand for the given email", async () => {
    const send = vi.fn(async () => ({}));
    await makeProvider(send).deleteUser("a@b.co");

    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0][0] as any;
    // Asserting the command TYPE as well as its input: an AdminDisableUserCommand
    // carrying the same input would satisfy a shape-only assertion while leaving
    // the email occupied in the pool — the one failure this method exists to avoid.
    expect(sent).toBeInstanceOf(AdminDeleteUserCommand);
    expect(sent.input).toEqual({ UserPoolId: "pool-1", Username: "a@b.co" });
  });

  it("maps UserNotFoundException to InvalidCredentialsError", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("nope"), { name: "UserNotFoundException" });
    });

    await expect(makeProvider(send).deleteUser("a@b.co")).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );
  });

  it("rethrows any other error unchanged", async () => {
    const boom = Object.assign(new Error("boom"), { name: "InternalErrorException" });
    const send = vi.fn(async () => {
      throw boom;
    });

    // The identity of the error matters, not just its type: the caller logs it to
    // raise the orphaned-pool-entry alert, and a wrapped error would lose the name.
    await expect(makeProvider(send).deleteUser("a@b.co")).rejects.toBe(boom);
  });
});
