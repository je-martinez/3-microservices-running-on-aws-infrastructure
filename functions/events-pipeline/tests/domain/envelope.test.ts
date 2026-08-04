import { describe, it, expect } from "vitest";
import { EnvelopeSchema } from "#domain/envelope";

describe("EnvelopeSchema", () => {
  it("accepts a valid USER_CREATED envelope with a null order_id", () => {
    const result = EnvelopeSchema.safeParse({
      event_id: "evt_abc123",
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_abc123",
      author: { actor: "users_api:register", user_id: "usr_abc123", cognito_sub: "sub-1" },
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
      author: { actor: "users_api:register", user_id: "usr_abc123", cognito_sub: "sub-1" },
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
      author: { actor: "users_api:register", user_id: "usr_abc123", cognito_sub: "sub-1" },
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
      author: { actor: "orders_api:create_order" },
      order_id: "",
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects an envelope omitting order_id entirely, distinct from an explicit null", () => {
    // `author` is present so order_id is the ONLY thing wrong — otherwise this
    // would pass for the wrong reason and stop testing order_id at all.
    const result = EnvelopeSchema.safeParse({
      event_id: "evt_abc123",
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_abc123",
      author: { actor: "users_api:register", user_id: "usr_abc123", cognito_sub: "sub-1" },
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
      author: { actor: "users_api:register", user_id: "usr_abc123", cognito_sub: "sub-1" },
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
      author: { actor: "users_api:register", user_id: "usr_abc123", cognito_sub: "sub-1" },
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
      author: { actor: "users_api:register", user_id: "usr_abc123", cognito_sub: "sub-1" },
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
      author: { actor: "users_api:register", user_id: "usr_abc123", cognito_sub: "sub-1" },
      order_id: null,
      payload: {},
    });
    expect(result.success).toBe(false);
  });
});

// `author` records WHO ORIGINATED the event, as distinct from the root `user_id`
// (the event's SUBJECT). It is required precisely so an unattributed event
// cannot slip through unnoticed.
describe("EnvelopeSchema — author", () => {
  function envelope(author: unknown): unknown {
    return {
      event_id: "evt_abc123",
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_subject",
      order_id: null,
      author,
      payload: {},
    };
  }

  it("REJECTS an envelope with no author at all", () => {
    // The whole reason the field is required rather than optional: an optional
    // one would silently permit unattributed events forever.
    const result = EnvelopeSchema.safeParse({
      event_id: "evt_abc123",
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_subject",
      order_id: null,
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("accepts an author with only `actor` — no human originated the event", () => {
    // The carrier webhook: a real event about a real user, caused by nobody.
    const result = EnvelopeSchema.safeParse(
      envelope({ actor: "tracking_api:carrier_status_update" }),
    );
    expect(result.success).toBe(true);
    expect(result.data?.author).toEqual({ actor: "tracking_api:carrier_status_update" });
    // Absent, not null and not defaulted to something invented.
    expect(result.data?.author).not.toHaveProperty("user_id");
    expect(result.data?.author).not.toHaveProperty("cognito_sub");
  });

  it("accepts an author carrying the real ids of a human actor", () => {
    const result = EnvelopeSchema.safeParse(
      envelope({
        actor: "users_api:register",
        user_id: "usr_author",
        cognito_sub: "a1b2-c3d4",
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data?.author.user_id).toBe("usr_author");
    expect(result.data?.author.cognito_sub).toBe("a1b2-c3d4");
    // The author is a DIFFERENT identity from the subject — the field would be
    // pointless if the two were required to agree.
    expect(result.data?.user_id).toBe("usr_subject");
  });

  it("rejects an author missing `actor`", () => {
    const result = EnvelopeSchema.safeParse(envelope({ user_id: "usr_author" }));
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string actor (.min(1))", () => {
    const result = EnvelopeSchema.safeParse(envelope({ actor: "" }));
    expect(result.success).toBe(false);
  });

  it("rejects a NULL author user_id — the key is omitted when unknown, never nulled", () => {
    // The rule from docs/shared/conventions/logging-context.md: a null reads as
    // a resolved value that happens to be null. `.optional()` (not `.nullable()`)
    // is what makes this fail.
    const result = EnvelopeSchema.safeParse(
      envelope({ actor: "tracking_api:carrier_status_update", user_id: null }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a NULL author cognito_sub for the same reason", () => {
    const result = EnvelopeSchema.safeParse(
      envelope({ actor: "tracking_api:carrier_status_update", cognito_sub: null }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string author user_id (.min(1)) rather than storing a blank id", () => {
    const result = EnvelopeSchema.safeParse(envelope({ actor: "users_api:register", user_id: "" }));
    expect(result.success).toBe(false);
  });

  it("rejects an author that is a bare string rather than an object", () => {
    // The shape the field deliberately is NOT: separating the actor label from
    // the real ids is the point.
    const result = EnvelopeSchema.safeParse(envelope("users_api:register"));
    expect(result.success).toBe(false);
  });
});
