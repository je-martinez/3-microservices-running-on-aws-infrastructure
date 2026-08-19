import { describe, it, expect, vi, beforeEach } from "vitest";
import { CaptureCognitoIdentityCommand, NoMatchingUserError } from "#features/users/webhooks/capture-cognito-identity";
import { deriveMessageId } from "#features/users/webhooks/message-id";
import { testSpanExporter } from "../../../setup-tracing.ts";
import { captureAppLogs, lineFor } from "../../../helpers/capture-app-logs.ts";

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

// Every line below asserts the record's `span_id` equals the `cognito_webhook`
// span's own. That is the whole point of the change: the no-match line used to
// be emitted by the route AFTER execute() returned, so the span had already
// ended and "View logs" on it in OpenObserve came back empty.
describe("CaptureCognitoIdentityCommand logging", () => {
  beforeEach(() => testSpanExporter.reset());

  function webhookSpanId(): string {
    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "cognito_webhook");
    expect(span).toBeDefined();
    return span!.spanContext().spanId;
  }

  it("logs cognito_webhook_started INSIDE the span, with the sub and trigger source", async () => {
    const db = dbMock();
    const lines = await captureAppLogs(async () => {
      await new CaptureCognitoIdentityCommand({ db }).execute(payload as never);
    });

    const started = lineFor(lines, "cognito_webhook_started");
    expect(started).toBeDefined();
    expect(started!.span_id).toBe(webhookSpanId());
    expect(started!.cognito_sub).toBe(payload.request.userAttributes.sub);
    expect(started!.trigger_source).toBe("PostConfirmation_ConfirmSignUp");
  });

  it("logs cognito_webhook_succeeded with capture_status=captured, inside the span", async () => {
    const db = dbMock();
    const lines = await captureAppLogs(async () => {
      await new CaptureCognitoIdentityCommand({ db }).execute(payload as never);
    });

    const done = lines.find(
      (l) => l.app_event === "cognito_webhook_succeeded" && l.capture_status === "captured",
    );
    expect(done).toBeDefined();
    expect(done!.span_id).toBe(webhookSpanId());
    expect(done!.user_id).toBe("usr_1");
  });

  it("logs a replayed delivery as succeeded/duplicate, not as a failure", async () => {
    const db = dbMock({
      usersCognitoData: {
        upsert: vi.fn(async () => {
          throw Object.assign(new Error("unique"), {
            code: "P2002",
            meta: { target: ["message_id"] },
          });
        }),
      },
    });

    const lines = await captureAppLogs(async () => {
      await new CaptureCognitoIdentityCommand({ db }).execute(payload as never);
    });

    const done = lines.find(
      (l) => l.app_event === "cognito_webhook_succeeded" && l.capture_status === "duplicate",
    );
    expect(done).toBeDefined();
    expect(done!.span_id).toBe(webhookSpanId());
    expect(done!.severity_text).toBe("INFO");
    expect(done!.message_id).toBe(deriveMessageId(
      payload.request.userAttributes.sub,
      payload.triggerSource,
    ));
  });

  it("logs cognito_webhook_no_match INSIDE the span (it used to fire after the span closed)", async () => {
    const db = dbMock({ user: { findFirst: vi.fn(async () => null) } });

    const lines = await captureAppLogs(async () => {
      await new CaptureCognitoIdentityCommand({ db })
        .execute(payload as never)
        .catch(() => undefined);
    });

    const noMatch = lineFor(lines, "cognito_webhook_no_match");
    expect(noMatch).toBeDefined();
    expect(noMatch!.reason).toBe("no_matching_user");
    expect(noMatch!.severity_text).toBe("ERROR");
    expect(noMatch!.span_id).toBe(webhookSpanId());
  });

  it("never puts the plaintext email or the raw payload on any line", async () => {
    const db = dbMock();
    const lines = await captureAppLogs(async () => {
      await new CaptureCognitoIdentityCommand({ db }).execute(payload as never);
    });

    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("a@b.com");
    // The payload is persisted in full but is a request body — it never logs.
    expect(serialized).not.toContain("email_verified");
    expect(lineFor(lines, "cognito_webhook_started")!.email_hash).toBeDefined();
  });
});
