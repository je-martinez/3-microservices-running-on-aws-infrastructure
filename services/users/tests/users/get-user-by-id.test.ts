import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { Module } from "@nestjs/common";
import { CqrsModule, QueryBus } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import { DB } from "#shared/tokens";
import {
  GetUserByIdHandler,
  GetUserByIdQuery,
} from "../../src/users/queries/get-user-by-id.query.ts";

async function buildBus(row: unknown) {
  const db = { user: { findByIdOrCognitoSub: vi.fn(async () => row) } };

  @Module({
    imports: [CqrsModule],
    providers: [{ provide: DB, useValue: db }, GetUserByIdHandler],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  await moduleRef.init();
  return { bus: moduleRef.get(QueryBus), db, close: () => moduleRef.close() };
}

describe("GetUserByIdQuery through the QueryBus", () => {
  it("returns the domain user when a row exists", async () => {
    const { bus, db, close } = await buildBus({
      id: "usr_1",
      email: "ada@example.com",
      fullName: "Ada",
      cognitoSub: "cognito-sub-1",
      address: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: null,
    });

    expect(await bus.execute(new GetUserByIdQuery("usr_1"))).toMatchObject({ id: "usr_1" });
    expect(db.user.findByIdOrCognitoSub).toHaveBeenCalledWith("usr_1");
    await close();
  });

  it("returns null when no row matches, so gRPC can map NOT_FOUND", async () => {
    const { bus, close } = await buildBus(null);

    expect(await bus.execute(new GetUserByIdQuery("usr_missing"))).toBeNull();
    await close();
  });

  it("resolves a Cognito sub through the same lookup as a usr_ id", async () => {
    const { bus, db, close } = await buildBus(null);

    await bus.execute(new GetUserByIdQuery("cognito-sub-1"));

    expect(db.user.findByIdOrCognitoSub).toHaveBeenCalledWith("cognito-sub-1");
    await close();
  });
});
