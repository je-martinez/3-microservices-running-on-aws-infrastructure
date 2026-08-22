import { describe, it, expect, vi, beforeEach } from "vitest";
import { getUserByIdHandler } from "#features/users/grpc/get-user-by-id";
import { testSpanExporter } from "../../../setup-tracing.ts";
import { captureAppLogs, lineFor } from "../../../helpers/capture-app-logs.ts";

const METHOD = "users.v1.Users/GetUserById";

describe("getUserByIdHandler", () => {
  it("delegates to the query service with the request id", async () => {
    const getUserById = vi.fn(async () => ({ id: "usr_1" }));
    const userQueryService = { getUserById } as any;
    const res = await getUserByIdHandler({ userQueryService }, { request: { id: "usr_1" } } as any);
    expect(getUserById).toHaveBeenCalledWith("usr_1");
    expect(res.user).toEqual({ id: "usr_1" });
  });
});

// The service's only gRPC surface, and it emitted no log line at all: an
// inbound lookup from Tracking left nothing in the log stream, so the span's
// "View logs" in OpenObserve came back empty. Both lines below therefore assert
// the record's span_id equals the SERVER span's own.
describe("getUserByIdHandler logging", () => {
  beforeEach(() => testSpanExporter.reset());

  function serverSpanId(): string {
    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === METHOD);
    expect(span).toBeDefined();
    return span!.spanContext().spanId;
  }

  it("logs get_user_by_id_succeeded with the resolved user_id, inside the span", async () => {
    const userQueryService = { getUserById: vi.fn(async () => ({ id: "usr_1" })) } as any;

    const lines = await captureAppLogs(async () => {
      await getUserByIdHandler({ userQueryService }, { request: { id: "usr_1" } } as any);
    });

    const line = lineFor(lines, "get_user_by_id_succeeded");
    expect(line).toBeDefined();
    expect(line!.user_id).toBe("usr_1");
    expect(line!.span_id).toBe(serverSpanId());
  });

  it("logs get_user_by_id_failed with reason=user_not_found on a miss, inside the span", async () => {
    // A miss is a routine outcome mapped to NOT_FOUND by the server, not a
    // throw — so it is told apart by app_event/reason, not by span status.
    const userQueryService = { getUserById: vi.fn(async () => null) } as any;

    const lines = await captureAppLogs(async () => {
      await getUserByIdHandler({ userQueryService }, { request: { id: "sub-uuid" } } as any);
    });

    const line = lineFor(lines, "get_user_by_id_failed");
    expect(line).toBeDefined();
    expect(line!.reason).toBe("user_not_found");
    expect(line!.span_id).toBe(serverSpanId());
    expect(lineFor(lines, "get_user_by_id_succeeded")).toBeUndefined();
  });

  it("resolves a lookup by Cognito sub without logging a user_id it never resolved", async () => {
    // Omitted, never null — the miss branch has no user to name.
    const userQueryService = { getUserById: vi.fn(async () => null) } as any;

    const lines = await captureAppLogs(async () => {
      await getUserByIdHandler({ userQueryService }, { request: { id: "sub-uuid" } } as any);
    });

    expect("user_id" in lineFor(lines, "get_user_by_id_failed")!).toBe(false);
  });
});
