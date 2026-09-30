import { Inject } from "@nestjs/common";
import { type IQueryHandler, QueryHandler } from "@nestjs/cqrs";
import type { Db } from "#shared/db/prisma";
import { DB } from "#shared/tokens";

export class ListPaymentMethodsQuery {
  constructor(public readonly userId: string) {}
}

export interface PaymentMethodView {
  id: string;
  type: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

// CONTRACT: Reads only the local table, never Stripe (spec D4: "listing reads
// local") — Stripe is authoritative and a webhook keeps this table in sync, so a
// live Stripe call here would be a redundant round-trip on the hottest read path.
@QueryHandler(ListPaymentMethodsQuery)
export class ListPaymentMethodsHandler implements IQueryHandler<ListPaymentMethodsQuery> {
  constructor(@Inject(DB) private readonly db: Db) {}

  async execute({ userId }: ListPaymentMethodsQuery): Promise<PaymentMethodView[]> {
    const rows = await this.db.stripePaymentMethod.findMany({
      where: { userId, deletedAt: null },
      orderBy: { isDefault: "desc" },
    });
    return rows.map((r) => ({
      id: r.stripePaymentMethodId,
      type: r.type,
      brand: r.brand,
      last4: r.last4,
      expMonth: r.expMonth,
      expYear: r.expYear,
      isDefault: r.isDefault,
    }));
  }
}
