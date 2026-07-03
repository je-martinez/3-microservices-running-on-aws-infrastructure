import { describe, it, expect, vi } from "vitest";
import { RegisterUserCommand } from "../../../../src/features/users/commands/register.js";

function deps(overrides = {}) {
  const created: any = {};
  return {
    db: { user: { create: vi.fn(async ({ data }: any) => { Object.assign(created, data); return data; }) } },
    auth: { signUp: vi.fn(async () => ({ sub: "sub_1" })), login: vi.fn() },
    events: { publishUserCreated: vi.fn(async () => {}) },
    _created: created,
    ...overrides,
  } as any;
}

describe("RegisterUserCommand", () => {
  it("adds 'E2E Source' to tags when e2eSource is true", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    const user = await command.execute({ email: "a@b.c", password: "P!1", fullName: "A", e2eSource: true });
    expect(user.tags).toContain("E2E Source");
    expect(d.events.publishUserCreated).toHaveBeenCalledOnce();
  });

  it("leaves tags empty when e2eSource is false", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    const user = await command.execute({ email: "a@b.c", password: "P!1", fullName: "A", e2eSource: false });
    expect(user.tags).toEqual([]);
  });

  it("generates a usr_-prefixed id and passes it explicitly in create data (self-actor semantics)", async () => {
    const d = deps();
    const command = new RegisterUserCommand(d);
    const user = await command.execute({ email: "a@b.c", password: "P!1", fullName: "A", e2eSource: false });
    expect(user.id).toMatch(/^usr_/);
    expect(d._created.id).toBe(user.id);
  });
});
