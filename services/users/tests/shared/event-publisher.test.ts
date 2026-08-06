import { describe, it, expect } from "vitest";
import { NoopEventPublisher } from "#shared/messaging/event-publisher";

describe("NoopEventPublisher", () => {
  it("resolves without throwing", async () => {
    const pub = new NoopEventPublisher();
    await expect(
      pub.publishUserCreated({
        id: "usr_a",
        email: "a@b.c",
        fullName: "A B",
        createdAt: new Date("2026-01-15T10:30:00.000Z"),
      }),
    ).resolves.toBeUndefined();
  });
});
