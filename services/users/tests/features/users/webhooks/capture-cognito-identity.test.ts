import { describe, it, expect, vi } from "vitest";
import { CaptureCognitoIdentityCommand, NoMatchingUserError } from "#features/users/webhooks/capture-cognito-identity";
import { deriveMessageId } from "#features/users/webhooks/message-id";

const payload = {
  version: "1",
  triggerSource: "PostConfirmation_ConfirmSignUp" as const,
  region: "us-east-1",
  userPoolId: "pool",
  userName: "a@b.com",
  callerContext: { awsSdkVersion: "v3", clientId: "cli_1" },
  request: {
    userAttributes: {
      sub: "7904d681-f590-4b4d-bbce-15348a898873",
      email: "a@b.com",
      email_verified: "true",
    },
  },
};

function dbMock(over: Record<string, unknown> = {}) {
  return {
    user: { findFirst: vi.fn(async () => ({ id: "usr_1" })) },
    usersCognitoData: { upsert: vi.fn(async () => ({ id: "ucd_1" })) },
    ...over,
  } as any;
}

describe("CaptureCognitoIdentityCommand", () => {
  it("captures: a single upsert nests the event", async () => {
    const db = dbMock();
    const res = await new CaptureCognitoIdentityCommand({ db }).execute(payload);
    expect(res.status).toBe("captured");
    expect(db.usersCognitoData.upsert).toHaveBeenCalledOnce();
    const args = db.usersCognitoData.upsert.mock.calls[0][0];
    expect(args.create.events.create[0].messageId).toBe(
      deriveMessageId(payload.request.userAttributes.sub, payload.triggerSource),
    );
    expect(args.update.events.create[0].messageId).toBe(
      deriveMessageId(payload.request.userAttributes.sub, payload.triggerSource),
    );
  });

  it("returns duplicate when the nested event write collides on message_id (P2002, real driver-adapter shape)", async () => {
    // Real shape captured live against Floci Postgres under Prisma v7 +
    // @prisma/adapter-pg: `meta.target` is undefined; the constraint is
    // nested under `meta.driverAdapterError.cause`.
    const db = dbMock({
      usersCognitoData: {
        upsert: vi.fn(async () => {
          throw Object.assign(new Error("unique"), {
            code: "P2002",
            meta: {
              modelName: "UsersCognitoData",
              driverAdapterError: {
                name: "DriverAdapterError",
                cause: {
                  originalCode: "23505",
                  originalMessage:
                    'duplicate key value violates unique constraint "users_cognito_events_message_id_key"',
                  kind: "UniqueConstraintViolation",
                  constraint: { fields: ["message_id"] },
                },
              },
            },
          });
        }),
      },
    });
    const res = await new CaptureCognitoIdentityCommand({ db }).execute(payload);
    expect(res.status).toBe("duplicate");
  });

  it("re-throws a P2002 that does NOT target message_id (narrow-catch guard, classic shape)", async () => {
    const db = dbMock({
      usersCognitoData: {
        upsert: vi.fn(async () => {
          throw Object.assign(new Error("unique"), {
            code: "P2002",
            meta: { target: ["users_cognito_data_pkey"] },
          });
        }),
      },
    });
    await expect(new CaptureCognitoIdentityCommand({ db }).execute(payload)).rejects.toThrow();
  });

  it("re-throws a P2002 on the pkey constraint under the driver-adapter shape (narrow-catch guard)", async () => {
    const db = dbMock({
      usersCognitoData: {
        upsert: vi.fn(async () => {
          throw Object.assign(new Error("unique"), {
            code: "P2002",
            meta: {
              modelName: "UsersCognitoData",
              driverAdapterError: {
                name: "DriverAdapterError",
                cause: {
                  originalCode: "23505",
                  originalMessage:
                    'duplicate key value violates unique constraint "users_cognito_data_pkey"',
                  kind: "UniqueConstraintViolation",
                  constraint: { fields: ["id"] },
                },
              },
            },
          });
        }),
      },
    });
    await expect(new CaptureCognitoIdentityCommand({ db }).execute(payload)).rejects.toThrow();
  });

  it("throws NoMatchingUserError and does not upsert when no users row matches", async () => {
    const db = dbMock({ user: { findFirst: vi.fn(async () => null) } });
    await expect(new CaptureCognitoIdentityCommand({ db }).execute(payload))
      .rejects.toBeInstanceOf(NoMatchingUserError);
    expect(db.usersCognitoData.upsert).not.toHaveBeenCalled();
  });

  it("re-throws a non-object throw (null) instead of mislabeling it", async () => {
    const db = dbMock({
      usersCognitoData: { upsert: vi.fn(async () => { throw null; }) },
    });
    await expect(new CaptureCognitoIdentityCommand({ db }).execute(payload)).rejects.toBeNull();
  });
});
