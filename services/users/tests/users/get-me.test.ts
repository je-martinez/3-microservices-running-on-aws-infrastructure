import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { Module } from "@nestjs/common";
import { CqrsModule, QueryBus } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { testSpanExporter } from "../setup.ts";
import { GetMeHandler, GetMeQuery } from "../../src/users/queries/get-me.query.ts";
import { WorkflowInterceptor } from "#shared/observability/workflow.interceptor";
import { RoutineFailure } from "#shared/observability/workflow-metadata";

const ROW = {
  id: "usr_1",
  email: "ada@example.com",
  fullName: "Ada Lovelace",
  cognitoSub: "cognito-sub-1",
  address: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  deletedAt: null,
};

async function buildBus(resolved: unknown) {
  @Module({
    imports: [CqrsModule],
    providers: [
      GetMeHandler,
      { provide: APP_INTERCEPTOR, useClass: WorkflowInterceptor },
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  const currentUser = { resolve: vi.fn(async () => resolved) };
  return { bus: moduleRef.get(QueryBus), currentUser, close: () => moduleRef.close() };
}

describe("GetMeQuery through the QueryBus", () => {
  beforeEach(() => testSpanExporter.reset());

  it("returns the domain user for a resolved caller", async () => {
    const { bus, currentUser, close } = await buildBus(ROW);

    const result = await bus.execute(new GetMeQuery(currentUser as never));

    expect(result).toMatchObject({ id: "usr_1", email: "ada@example.com" });
    await close();
  });

  it("emits app_event=get_profile_succeeded with the resolved user_id", async () => {
    const { bus, currentUser, close } = await buildBus(ROW);

    await bus.execute(new GetMeQuery(currentUser as never));

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "get_profile");
    expect(span!.attributes.app_event).toBe("get_profile_succeeded");
    expect(span!.attributes.user_id).toBe("usr_1");
    expect(span!.status.code).toBe(SpanStatusCode.OK);
    await close();
  });

  it("reports a missing user as a ROUTINE failure — reason set, span status NOT error", async () => {
    // CONTRACT: The route turns this into a 404. It is a normal outcome, so the
    // span keeps OK status and records the reason instead.
    const { bus, currentUser, close } = await buildBus(null);

    const result = await bus.execute(new GetMeQuery(currentUser as never));

    expect(result).toBeNull();
    expect(result).not.toBeInstanceOf(RoutineFailure);
    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "get_profile");
    expect(span!.attributes.app_event).toBe("get_profile_failed");
    expect(span!.attributes.reason).toBe("user_not_found");
    expect(span!.status.code).not.toBe(SpanStatusCode.ERROR);
    await close();
  });

  it("resolves the caller exactly once per query", async () => {
    const { bus, currentUser, close } = await buildBus(ROW);

    await bus.execute(new GetMeQuery(currentUser as never));

    expect(currentUser.resolve).toHaveBeenCalledOnce();
    await close();
  });

  it("puts no identity guess on the span before the user resolves", async () => {
    // The x-user-id header is either a `usr_` id or a Cognito sub, so labelling
    // it as either would be a guess. Only the RESOLVED user_id is recorded.
    const { bus, currentUser, close } = await buildBus(null);

    await bus.execute(new GetMeQuery(currentUser as never));

    const span = testSpanExporter.getFinishedSpans().find((s) => s.name === "get_profile");
    expect(span!.attributes.user_id).toBeUndefined();
    await close();
  });
});
