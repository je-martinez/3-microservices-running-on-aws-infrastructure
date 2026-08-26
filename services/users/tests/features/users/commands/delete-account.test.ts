import { describe, it, expect, vi } from "vitest";
import { DeleteAccountCommand } from "#features/users/commands/delete-account";
import { AuditActor } from "#shared/audit/audit-actor";
import { getActor } from "#shared/audit/actor-context";
import { CascadeFailedError, CascadeUnavailableError } from "#shared/http/cascade-client";
import { CurrentUser } from "#shared/auth/current-user";
import { captureAppLogs, lineFor } from "../../../helpers/capture-app-logs.ts";

const TARGET = {
  id: "usr_1",
  email: "a@b.co",
  cognitoSub: "sub-1",
  fullName: "A",
  address: null,
  phoneNumber: null,
  tags: [],
  createdBy: null,
  createdAt: new Date(),
  updatedBy: null,
  updatedAt: new Date(),
  deletedBy: null,
  deletedAt: null,
};

function makeDeps(target: typeof TARGET | null = TARGET) {
  const seenActor: { value?: string } = {};
  const del = vi.fn(async () => {
    // Captured inside the fake, which is where the extension would read it.
    seenActor.value = getActor();
    return { ...TARGET, deletedAt: new Date() };
  });
  const db = {
    user: { findByIdOrCognitoSub: vi.fn(async () => target), delete: del },
  } as any;
  const cascade = {
    deleteOrdersForUser: vi.fn(async () => {}),
    deleteTrackingsForUser: vi.fn(async () => {}),
  };
  const auth = { deleteUser: vi.fn(async () => {}) };
  const metricsPublisher = { publish: vi.fn(async () => {}) };
  return { db, cascade, auth, metricsPublisher, del, seenActor };
}

describe("DeleteAccountCommand", () => {
  it("cascades to BOTH services before deleting the account", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    const order: string[] = [];
    cascade.deleteOrdersForUser.mockImplementation(async () => void order.push("orders"));
    cascade.deleteTrackingsForUser.mockImplementation(async () => void order.push("tracking"));
    db.user.delete.mockImplementation(async () => {
      order.push("users");
      return TARGET;
    });
    auth.deleteUser.mockImplementation(async () => void order.push("cognito"));

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    const result = await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(
      currentUser,
    );

    expect(result).toBe("deleted");
    // The order IS the safety property, so it is asserted directly rather than
    // inferred from the individual calls having happened.
    expect(order).toEqual(["orders", "tracking", "users", "cognito"]);
  });

  it("passes both identities to Tracking", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(currentUser);

    expect(cascade.deleteTrackingsForUser).toHaveBeenCalledWith("sub-1", "usr_1");
  });

  it("stamps the DeleteAccount audit actor", async () => {
    const { db, cascade, auth, metricsPublisher, seenActor } = makeDeps();
    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(currentUser);

    expect(seenActor.value).toBe(AuditActor.DeleteAccount);
  });

  it("returns not_found and touches nothing when the user does not exist", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps(null);
    const currentUser = new CurrentUser({ db, identity: "ghost" });
    const result = await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(
      currentUser,
    );

    expect(result).toBe("not_found");
    expect(cascade.deleteOrdersForUser).not.toHaveBeenCalled();
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });

  it("does NOT delete the account when the Orders cascade fails", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    cascade.deleteOrdersForUser.mockRejectedValue(new CascadeFailedError("orders", "status 500"));

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await expect(
      new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(currentUser),
    ).rejects.toBeInstanceOf(CascadeFailedError);

    // The account survives, so the user can still authenticate and retry. This is
    // the entire reason the cascade runs before the deletion.
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });

  it("does NOT delete the account when the Tracking cascade fails", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    cascade.deleteTrackingsForUser.mockRejectedValue(
      new CascadeFailedError("tracking", "status 503"),
    );

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await expect(
      new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(currentUser),
    ).rejects.toBeInstanceOf(CascadeFailedError);

    // Orders already deleted here. That is accepted and recoverable: both internal
    // routes are idempotent, so the user's retry re-runs Orders as a no-op and
    // completes Tracking.
    expect(db.user.delete).not.toHaveBeenCalled();
  });

  it("still reports success when Cognito fails after the row is stamped", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    auth.deleteUser.mockRejectedValue(new Error("cognito down"));

    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    const result = await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(
      currentUser,
    );

    // Postgres has committed; failing the request would tell the user their delete
    // did not happen when it did. The orphaned pool entry is logged loudly instead.
    expect(result).toBe("deleted");
    expect(db.user.delete).toHaveBeenCalled();
  });

  // ── Observability ────────────────────────────────────────────────────────
  // The flow carries the full app_event triad per [[logging-context]]. These
  // assert the LINES, not just the span attributes: withWorkflowSpan puts
  // `delete_account_started` on the span only, so without an explicit log call
  // the started event would exist in traces and be absent from logs.

  it("logs the started/succeeded triad with email_hash and user_id", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    const currentUser = new CurrentUser({ db, identity: "sub-1" });

    const lines = await captureAppLogs(async () => {
      await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(
        currentUser,
      );
    });

    const started = lineFor(lines, "delete_account_started");
    const succeeded = lineFor(lines, "delete_account_succeeded");
    expect(started).toBeDefined();
    expect(succeeded).toBeDefined();
    expect(started!.user_id).toBe("usr_1");
    expect(started!.email_hash).toBeTypeOf("string");
    // Not an auth flow, so it gets no masked-email exemption: the address must
    // never appear in any form.
    expect(JSON.stringify(lines)).not.toContain("a@b.co");
  });

  it("logs a failed line naming WHICH cascade leg did not confirm", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    cascade.deleteTrackingsForUser.mockRejectedValue(
      new CascadeFailedError("tracking", "status 503"),
    );
    const currentUser = new CurrentUser({ db, identity: "sub-1" });

    const lines = await captureAppLogs(async () => {
      await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any)
        .execute(currentUser)
        .catch(() => undefined);
    });

    const failed = lineFor(lines, "delete_account_failed");
    expect(failed).toBeDefined();
    // The 502 the user sees is diagnosable only if the log says which side failed.
    expect(failed!.reason).toBe("cascade_failed_tracking");
    expect(failed!.severity_text).toBe("ERROR");
  });

  it("logs a failed line with reason not_found for an unknown user", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps(null);
    const currentUser = new CurrentUser({ db, identity: "ghost" });

    const lines = await captureAppLogs(async () => {
      await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(
        currentUser,
      );
    });

    expect(lineFor(lines, "delete_account_failed")?.reason).toBe("not_found");
  });

  it("refuses to cascade a user with no cognito sub, naming the real reason", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps({ ...TARGET, cognitoSub: null } as any);
    const currentUser = new CurrentUser({ db, identity: "usr_1" });

    const lines = await captureAppLogs(async () => {
      await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any)
        .execute(currentUser)
        .catch(() => undefined);
    });

    // Sending `?? ""` downstream would make Orders answer 400 and Tracking match
    // nothing, surfacing as a status code that says nothing about the cause.
    expect(cascade.deleteOrdersForUser).not.toHaveBeenCalled();
    expect(db.user.delete).not.toHaveBeenCalled();
    expect(lineFor(lines, "delete_account_failed")?.reason).toBe("missing_cognito_sub");
  });

  it("blames no downstream service when the cascade was never attempted", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps({ ...TARGET, cognitoSub: null } as any);
    const currentUser = new CurrentUser({ db, identity: "usr_1" });

    const error = await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any)
      .execute(currentUser)
      .catch((e) => e);

    // A CascadeFailedError would have to name a service, and naming one for a call
    // that never happened puts a lie in the logs and the trace.
    expect(error).toBeInstanceOf(CascadeUnavailableError);
    expect(error).not.toBeInstanceOf(CascadeFailedError);
    expect(String(error.message)).not.toContain("orders");
  });

  it("publishes the users_deleted_total counter", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    const currentUser = new CurrentUser({ db, identity: "sub-1" });
    await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any).execute(
      currentUser,
    );

    // The counterpart to users_registered_total — without it churn is invisible.
    expect(metricsPublisher.publish).toHaveBeenCalledWith("users_deleted_total", 1, {
      Service: "users",
    });
  });

  it("does not publish the counter when the cascade fails", async () => {
    const { db, cascade, auth, metricsPublisher } = makeDeps();
    cascade.deleteOrdersForUser.mockRejectedValue(new CascadeFailedError("orders", "status 500"));
    const currentUser = new CurrentUser({ db, identity: "sub-1" });

    await new DeleteAccountCommand({ db, cascade, auth, metricsPublisher } as any)
      .execute(currentUser)
      .catch(() => undefined);

    // A deletion that did not happen must not be counted.
    expect(metricsPublisher.publish).not.toHaveBeenCalled();
  });
});
