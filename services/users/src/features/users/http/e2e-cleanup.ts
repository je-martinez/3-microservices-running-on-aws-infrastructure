import type { PrismaClient } from "../../../generated/prisma/client.js";
import { stampSoftDelete } from "../../../shared/audit/audit.js";

// Constructor-injected from the Awilix cradle (PROXY injection mode).
// Soft-deletes (never hard-deletes) every user tagged "E2E Source".
export class E2eCleanupCommand {
  private readonly writer: PrismaClient;

  constructor({ writer }: { writer: PrismaClient }) {
    this.writer = writer;
  }

  async execute(): Promise<{ count: number }> {
    const stamp = stampSoftDelete("e2e-cleanup");
    const res = await this.writer.user.updateMany({
      where: { tags: { has: "E2E Source" }, deletedAt: null },
      data: { deletedAt: stamp.deletedAt, deletedBy: stamp.deletedBy },
    });
    return { count: res.count };
  }
}
