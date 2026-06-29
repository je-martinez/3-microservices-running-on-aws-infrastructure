import { describe, it, expect } from "vitest";
import { NoopEventPublisher } from "../../src/shared/messaging/event-publisher.js";

describe("NoopEventPublisher", () => {
  it("resolves without throwing", async () => {
    const pub = new NoopEventPublisher();
    await expect(pub.publishUserCreated({ id: "usr_a", email: "a@b.c" })).resolves.toBeUndefined();
  });
});
