import { describe, it, expect } from "vitest";
import { stampCreate, stampSoftDelete, isDeleted } from "../../src/shared/audit/audit.js";

describe("audit", () => {
  it("stamps creator on create", () => {
    expect(stampCreate("usr_a")).toEqual({ createdBy: "usr_a", updatedBy: "usr_a" });
  });
  it("stamps deleter + timestamp on soft delete", () => {
    const s = stampSoftDelete("usr_a");
    expect(s.deletedBy).toBe("usr_a");
    expect(s.deletedAt).toBeInstanceOf(Date);
  });
  it("derives isDeleted from deletedAt", () => {
    expect(isDeleted({ deletedAt: null })).toBe(false);
    expect(isDeleted({ deletedAt: new Date() })).toBe(true);
  });
});
