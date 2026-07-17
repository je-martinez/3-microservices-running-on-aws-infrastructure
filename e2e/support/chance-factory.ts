import { randomUUID } from "node:crypto";
import Chance from "chance";

// Seed per run for reproducibility of the generated fields (name/address/etc.).
const chance = new Chance(Number(process.env.E2E_SEED ?? 1));

export function makeUser() {
  // Email uniqueness must NOT depend on Chance: the seed is deterministic per
  // process, so parallel workers that call makeUser() in the same millisecond
  // would get the same Date.now() AND the same seeded guid() → identical email →
  // register 409. Use crypto.randomUUID() (non-deterministic, seed-independent)
  // so every user is unique regardless of worker/timing.
  const unique = randomUUID();
  return {
    email: `e2e+${unique}@example.com`,
    password: `Aa1!${chance.string({ length: 10, alpha: true, numeric: true })}`,
    fullName: chance.name(),
    phoneNumber: chance.phone(),
    address: { line1: chance.address(), city: chance.city(), country: chance.country({ full: true }) },
  };
}
