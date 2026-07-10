import type { Db } from "#shared/db/prisma";

// Read-only counterpart to E2eCleanupCommand. Exists solely so the E2E suite can
// assert that Cognito identity capture actually wrote its rows, instead of
// shelling out to psql from a Playwright spec. Registered only when
// E2E_TESTING_ENABLED — it must never exist in production.
//
// Constructor-injected from the Awilix cradle (PROXY injection mode).
export class E2eIdentityQuery {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async execute(email: string): Promise<{ data: number; events: number }> {
    const snapshot = await this.db.usersCognitoData.findFirst({ where: { email } });
    if (!snapshot) return { data: 0, events: 0 };
    const events = await this.db.usersCognitoEvent.count({
      where: { cognitoSub: snapshot.cognitoSub },
    });
    return { data: 1, events };
  }
}
