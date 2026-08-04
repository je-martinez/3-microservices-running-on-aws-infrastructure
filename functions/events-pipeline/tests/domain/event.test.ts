import { describe, it, expect } from "vitest";
import { EVENT_ID_PREFIX, type EventDocument, type EventStatus } from "#domain/event";

describe("event domain constants", () => {
  it("exposes the evt_ friendlyId prefix", () => {
    expect(EVENT_ID_PREFIX).toBe("evt_");
  });

  it("accepts a well-formed EventDocument shape", () => {
    const doc: EventDocument = {
      friendlyId: "evt_abc123",
      event_id: "evt_abc123",
      order_id: null,
      user_id: "usr_abc123",
      type: "USER_CREATED",
      source: "users",
      payload: {},
      status: "STARTED" satisfies EventStatus,
      error: null,
      status_history: [{ status: "STARTED", timestamp: new Date() }],
      createdBy: "events-pipeline",
      createdAt: new Date(),
      updatedBy: "events-pipeline",
      updatedAt: new Date(),
      deletedBy: null,
      deletedAt: null,
      isDeleted: false,
    };
    expect(doc.status).toBe("STARTED");
  });
});
