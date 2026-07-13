import { describe, it, expect } from "vitest";
import { AuditActor } from "#shared/audit/audit-actor";

// The audit columns store `<source>:<action>` semantic values (see
// [[audit-fields]]). These assertions pin the wire values: they land verbatim
// in createdBy/updatedBy, so changing one is a data-format change, not a rename.
describe("AuditActor", () => {
  it("uses the users_api source with per-action values", () => {
    expect(AuditActor.Register).toBe("users_api:register");
    expect(AuditActor.UpdateProfile).toBe("users_api:update_profile");
    expect(AuditActor.IdentityCapture).toBe("users_api:identity_capture");
    expect(AuditActor.E2eCleanup).toBe("users_api:e2e_cleanup");
  });

  it("has every value under the users_api source", () => {
    for (const value of Object.values(AuditActor)) {
      expect(value).toMatch(/^users_api:[a-z0-9_]+$/);
    }
  });
});
