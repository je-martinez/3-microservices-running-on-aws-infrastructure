import type { PrismaClient } from "@prisma/client";
import { stampSoftDelete } from "../../../shared/audit/audit.js";

// Soft-deletes (never hard-deletes) every user tagged "E2E Source".
export async function softDeleteE2EUsers(deps: { writer: PrismaClient }): Promise<{ count: number }> {
  const stamp = stampSoftDelete("e2e-cleanup");
  const res = await deps.writer.user.updateMany({
    where: { tags: { has: "E2E Source" }, deletedAt: null },
    data: { deletedAt: stamp.deletedAt, deletedBy: stamp.deletedBy },
  });
  return { count: res.count };
}
