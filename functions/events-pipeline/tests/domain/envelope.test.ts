import { describe, it, expect } from "vitest";
import { EnvelopeSchema } from "#domain/envelope";

describe("EnvelopeSchema", () => {
  it("accepts a valid USER_CREATED envelope with a null order_id", () => {
    const result = EnvelopeSchema.safeParse({
      event_id: "evt_abc123",
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_abc123",
      order_id: null,
      payload: { id: "usr_abc123", email: "jo*****e@gmail.com" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an envelope missing event_id", () => {
    const result = EnvelopeSchema.safeParse({
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_abc123",
      order_id: null,
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects an envelope with a non-object payload", () => {
    const result = EnvelopeSchema.safeParse({
      event_id: "evt_abc123",
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_abc123",
      order_id: null,
      payload: "not-an-object",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string order_id (.min(1) on a nullable field)", () => {
    const result = EnvelopeSchema.safeParse({
      event_id: "evt_abc123",
      type: "ORDER_CREATED",
      source: "orders",
      user_id: "usr_abc123",
      order_id: "",
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects an envelope omitting order_id entirely, distinct from an explicit null", () => {
    const result = EnvelopeSchema.safeParse({
      event_id: "evt_abc123",
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_abc123",
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string event_id (.min(1))", () => {
    const result = EnvelopeSchema.safeParse({
      event_id: "",
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_abc123",
      order_id: null,
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string type (.min(1))", () => {
    const result = EnvelopeSchema.safeParse({
      event_id: "evt_abc123",
      type: "",
      source: "users",
      user_id: "usr_abc123",
      order_id: null,
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string source (.min(1))", () => {
    const result = EnvelopeSchema.safeParse({
      event_id: "evt_abc123",
      type: "USER_CREATED",
      source: "",
      user_id: "usr_abc123",
      order_id: null,
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string user_id (.min(1))", () => {
    const result = EnvelopeSchema.safeParse({
      event_id: "evt_abc123",
      type: "USER_CREATED",
      source: "users",
      user_id: "",
      order_id: null,
      payload: {},
    });
    expect(result.success).toBe(false);
  });
});
