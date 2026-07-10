import { nanoid } from "nanoid";

// Single source of truth for prefixed nano IDs (see [[nano-id]]). Maps each
// Prisma model name to its ID prefix. The Prisma client extension (see
// `shared/db/prisma.ts`) reads this map to stamp `id` on `create`/`createMany`
// when the caller doesn't supply one — callers no longer generate IDs by hand.
//
// Extensibility: when new models are added (e.g. JE-38's `UsersCognitoData`,
// `UsersCognitoEvent`), just add an entry here — the extension itself never
// needs to change.
export const MODEL_ID_PREFIXES: Record<string, string> = {
  User: "usr_",
  UsersCognitoData: "ucd_",
  UsersCognitoEvent: "cge_",
};

export function generateId(prefix: string): string {
  return `${prefix}${nanoid()}`;
}
