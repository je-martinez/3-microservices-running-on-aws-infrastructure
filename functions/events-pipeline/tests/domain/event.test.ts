import { describe, it, expect } from "vitest";
import type { EventDocument, EventStatus } from "#domain/event";

describe("event domain shape", () => {
  it("accepts a well-formed EventDocument shape", () => {
    const doc: EventDocument = {
      event_id: "evt_abc123",
      order_id: null,
      user_id: "usr_abc123",
      type: "USER_CREATED",
      source: "users",
      payload: {},
      status: "STARTED" satisfies EventStatus,
      error: null,
      status_history: [{ status: "STARTED", timestamp: new Date() }],
      created_by: "events-pipeline",
      created_at: new Date(),
      updated_by: "events-pipeline",
      updated_at: new Date(),
      deleted_by: null,
      deleted_at: null,
      is_deleted: false,
    };
    expect(doc.status).toBe("STARTED");
  });

  it("names every persisted field in snake_case", () => {
    // The stored document has no ORM mapping layer (unlike Users/Prisma,
    // Tracking/SQLAlchemy and Orders/EF Core, which all map a camelCase
    // property onto a snake_case column), so the property name IS the field
    // name in DocumentDB. This test is the guard against camelCase drifting
    // back in.
    const doc: EventDocument = {
      event_id: "evt_abc123",
      order_id: null,
      user_id: "usr_abc123",
      type: "USER_CREATED",
      source: "users",
      payload: {},
      status: "STARTED",
      error: null,
      status_history: [{ status: "STARTED", timestamp: new Date() }],
      created_by: "events-pipeline",
      created_at: new Date(),
      updated_by: "events-pipeline",
      updated_at: new Date(),
      deleted_by: null,
      deleted_at: null,
      is_deleted: false,
    };

    for (const key of Object.keys(doc)) {
      expect(key).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    }
    for (const key of Object.keys(doc.status_history[0]!)) {
      expect(key).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    }
  });
});
