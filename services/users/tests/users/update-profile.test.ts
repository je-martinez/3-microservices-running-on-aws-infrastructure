import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CommandBus, CqrsModule } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../setup.ts";
import { DB } from "#shared/tokens";
import {
  UpdateProfileCommand,
  UpdateProfileHandler,
} from "../../src/users/commands/update-profile.command.ts";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";
import { RoutineFailure } from "#shared/observability/workflow-metadata";
import { AuditActor } from "#shared/audit/audit-actor";
import { getActor } from "#shared/audit/actor-context";

const FIXED = new Date("2026-01-01T00:00:00.000Z");

async function buildBus(overrides: { resolved?: unknown } = {}) {
  const resolved = "resolved" in overrides ? overrides.resolved : { id: "usr_1" };
  const seenActor: { value?: string } = {};
  const db = {
    user: {
      update: vi.fn(async () => {
        seenActor.value = getActor();
        return {
          id: "usr_1",
          email: "a@b.co",
          fullName: "New",
          address: null,
          phoneNumber: null,
          tags: [],
          authType: "PASSWORD",
          mustChangePassword: false,
          cognitoSub: "sub",
          createdBy: null,
          createdAt: FIXED,
          updatedBy: null,
          updatedAt: FIXED,
          deletedBy: null,
          deletedAt: null,
        };
      }),
    },
  };

  @Module({
    imports: [CqrsModule],
    providers: [
      { provide: DB, useValue: db },
      UpdateProfileHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return {
    bus: moduleRef.get(CommandBus),
    db,
    seenActor,
    currentUser: { resolve: vi.fn(async () => resolved) },
    close: () => moduleRef.close(),
  };
}

function span() {
  return testSpanExporter.getFinishedSpans().find((s) => s.name === "update_profile");
}

describe("UpdateProfileCommand through the CommandBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("resolves via the CurrentUser context, then updates by the resolved id", async () => {
    const { bus, db, currentUser, close } = await buildBus();
    const res = await bus.execute(
      new UpdateProfileCommand(currentUser as never, { fullName: "New" }),
    );
    expect(currentUser.resolve).toHaveBeenCalledOnce();
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "usr_1" },
      data: { fullName: "New" },
    });
    expect(res).toMatchObject({ id: "usr_1" });
    await close();
  });

  it("runs the update under the UpdateProfile audit actor", async () => {
    const { bus, seenActor, currentUser, close } = await buildBus();
    await bus.execute(new UpdateProfileCommand(currentUser as never, { fullName: "New" }));
    expect(seenActor.value).toBe(AuditActor.UpdateProfile);
    await close();
  });

  it("returns null and does not update when no user matches", async () => {
    const { bus, db, currentUser, close } = await buildBus({ resolved: null });
    const res = await bus.execute(
      new UpdateProfileCommand(currentUser as never, { fullName: "X" }),
    );
    expect(res).toBeNull();
    expect(res).not.toBeInstanceOf(RoutineFailure);
    expect(db.user.update).not.toHaveBeenCalled();
    await close();
  });

  it("marks the unresolved caller with reason=unknown_user and does NOT mark the span ERROR", async () => {
    const { bus, currentUser, close } = await buildBus({ resolved: null });
    await bus.execute(new UpdateProfileCommand(currentUser as never, { fullName: "X" }));
    expect(span()!.attributes.reason).toBe("unknown_user");
    expect(span()!.status.code).not.toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("emits update_profile_succeeded on success", async () => {
    const { bus, currentUser, close } = await buildBus();
    await bus.execute(new UpdateProfileCommand(currentUser as never, { fullName: "New" }));
    expect(span()!.attributes.app_event).toBe("update_profile_succeeded");
    expect(span()!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("only writes the fields present in the input", async () => {
    const { bus, db, currentUser, close } = await buildBus();
    await bus.execute(
      new UpdateProfileCommand(currentUser as never, { phoneNumber: "+1" }),
    );
    expect(db.user.update.mock.calls[0]![0].data).toEqual({ phoneNumber: "+1" });
    await close();
  });

  it("calls resolve once per execute", async () => {
    const { bus, currentUser, close } = await buildBus();
    await bus.execute(new UpdateProfileCommand(currentUser as never, { fullName: "New" }));
    expect(currentUser.resolve).toHaveBeenCalledTimes(1);
    await close();
  });
});
