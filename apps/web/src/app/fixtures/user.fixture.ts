import type { User } from "./api-types";

/**
 * services/users/openapi.yaml — User.
 * `address` is design-derived (see api-types.ts's Address comment), not
 * contract-derived: the contract types it as `anyOf: [{}, null]`.
 */
export const CURRENT_USER: User = {
  id: "usr_qN7fD2xVwM",
  email: "morgan.reyes@example.com",
  fullName: "Morgan Reyes",
  address: {
    line1: "482 Birch Hollow Lane",
    line2: "Unit 3B",
    city: "Portland",
    state: "OR",
    postalCode: "97201",
    country: "US",
  },
  phoneNumber: "+1-503-555-0142",
  tags: ["newsletter-subscriber"],
  authType: "PASSWORDLESS",
  mustChangePassword: false,
  // System-created, live, non-deleted user: the audit quartet is all null,
  // and isDeleted: false stays consistent with deletedAt: null.
  createdBy: null,
  createdAt: "2026-02-11T15:04:22Z",
  updatedBy: null,
  updatedAt: "2026-08-01T09:47:03Z",
  deletedBy: null,
  deletedAt: null,
  isDeleted: false,
};
