import Chance from "chance";

// Seed per run for reproducibility; emails made unique to avoid cross-run collisions.
const chance = new Chance(Number(process.env.E2E_SEED ?? 1));

export function makeUser() {
  const unique = `${Date.now()}.${chance.guid()}`;
  return {
    email: `e2e+${unique}@example.com`,
    password: `Aa1!${chance.string({ length: 10, alpha: true, numeric: true })}`,
    fullName: chance.name(),
    phoneNumber: chance.phone(),
    address: { line1: chance.address(), city: chance.city(), country: chance.country({ full: true }) },
  };
}
