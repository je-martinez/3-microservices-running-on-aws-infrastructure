import { isDeleted as deriveIsDeleted } from "../../../shared/audit/audit.js";

export interface UserRow {
  id: string;
  email: string;
  fullName: string;
  address: unknown | null;
  phoneNumber: string | null;
  tags: string[];
  createdBy: string | null;
  createdAt: Date;
  updatedBy: string | null;
  updatedAt: Date;
  deletedBy: string | null;
  deletedAt: Date | null;
}

export interface User extends UserRow {
  isDeleted: boolean;
}

export function toDomain(row: UserRow): User {
  return { ...row, isDeleted: deriveIsDeleted(row) };
}
