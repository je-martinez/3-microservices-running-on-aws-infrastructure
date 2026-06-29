export function stampCreate(actor: string): { createdBy: string; updatedBy: string } {
  return { createdBy: actor, updatedBy: actor };
}

export function stampSoftDelete(actor: string): { deletedBy: string; deletedAt: Date } {
  return { deletedBy: actor, deletedAt: new Date() };
}

export function isDeleted(row: { deletedAt: Date | null }): boolean {
  return row.deletedAt !== null;
}
