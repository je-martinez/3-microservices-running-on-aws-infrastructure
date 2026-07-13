import type { Db } from "#shared/db/prisma";
import { runAsActor } from "#shared/audit/actor-context";
import { AuditActor } from "#shared/audit/audit-actor";
import { MODEL_ID_PREFIXES, generateId } from "#shared/id/nano-id";
import { deriveMessageId } from "./message-id.ts";
import type { CognitoWebhookPayload } from "./cognito-payload.ts";

export type CaptureResult = { status: "captured" | "duplicate" };

// Shape of a Prisma P2002 error under the driver-adapter transport (v7 +
// @prisma/adapter-pg). The classic `err.meta.target` is undefined here —
// the constraint info is nested under `meta.driverAdapterError.cause`
// instead. All fields are read optionally since this is a best-effort probe
// over an untyped `unknown` error.
type PrismaP2002Error = {
  code?: string;
  meta?: {
    target?: string[] | string;
    driverAdapterError?: {
      cause?: {
        originalMessage?: string;
        constraint?: { fields?: string[] };
      };
    };
  };
};

// Narrow-catch guard: true only when this P2002 is the message_id unique
// violation (spec D4 idempotency), checking both the classic `meta.target`
// shape and the nested driver-adapter shape Prisma v7 actually produces.
// A P2002 from any other constraint (e.g. the snapshot's own pkey) must
// return false so the caller re-throws instead of mislabeling it duplicate.
function isMessageIdConflict(err: unknown): boolean {
  // A non-object throw (null/undefined/string) is never our P2002 — fall
  // through to false so the caller re-throws it untouched.
  if (typeof err !== "object" || err === null) return false;
  const e = err as PrismaP2002Error;
  if (e.code !== "P2002") return false;

  const target = e.meta?.target;
  if (Array.isArray(target) ? target.includes("message_id") : typeof target === "string" && target.includes("message_id")) {
    return true;
  }

  const cause = e.meta?.driverAdapterError?.cause;
  if (cause?.constraint?.fields?.includes("message_id")) return true;
  if (cause?.originalMessage?.includes("message_id")) return true;

  return false;
}

// Thrown when no `users` row matches the payload's email. Both real flows
// guarantee the user already exists before capture runs (local: register.ts
// creates the user before calling this command; prod: Cognito's
// PostConfirmation trigger fires only after the users service already
// persisted the user during registration). This is therefore an unexpected
// condition, not a routine outcome — the route maps it to an error response,
// and in prod Cognito retries the trigger, so a transient race self-heals.
export class NoMatchingUserError extends Error {
  constructor(email: string) {
    super(`No users row found for email ${email}`);
    this.name = "NoMatchingUserError";
  }
}

// The single persistence path for Cognito identity capture (spec D2). Reached
// two ways: over HTTP from the prod Lambda shim, and in-process from register()
// when NODE_ENV !== "production". Nothing here knows about HTTP.
//
// Constructor-injected from the Awilix cradle (PROXY injection mode).
export class CaptureCognitoIdentityCommand {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async execute(payload: CognitoWebhookPayload): Promise<CaptureResult> {
    const { sub, email } = payload.request.userAttributes;
    const messageId = deriveMessageId(sub, payload.triggerSource);

    // Reserve both ids up front. The generated Prisma create-input types
    // require `id` — these models have no `@default`, matching
    // register.ts:38 — so the extension's auto-stamp does NOT cover a
    // literal object-literal create like this one; omitting `id` here does
    // not compile (TS2322).
    const snapshotId = generateId(MODEL_ID_PREFIXES.UsersCognitoData);
    const eventId = generateId(MODEL_ID_PREFIXES.UsersCognitoEvent);

    // Audit fields (createdBy/updatedBy) are still stamped by the Prisma
    // extension; never set those here. `runAsActor` names the actor for this
    // non-request-bound write.
    return runAsActor(AuditActor.IdentityCapture, async () => {
      // No `users` row for this email is not a routine outcome (see
      // NoMatchingUserError) — fail before writing anything, rather than
      // persisting a partial snapshot or event.
      const user = await this.db.user.findFirst({ where: { email } });
      if (!user) throw new NoMatchingUserError(email);

      // One nested write: usersCognitoData.upsert with the event nested via
      // events: { create: [...] } in BOTH branches. Prisma runs this as a
      // single transaction (nested writes have transactional guarantees —
      // rollback on any failure), inserting the parent snapshot before the
      // child event, so the NOT NULL FK on
      // users_cognito_events.cognito_sub is satisfied by construction.
      // Verified live against Floci Postgres on both the first-delivery
      // (create) and retry (update) paths — spec "Persistence: a single
      // nested write".
      try {
        await this.db.usersCognitoData.upsert({
          where: { cognitoSub: sub },
          create: {
            id: snapshotId,
            userId: user.id,
            cognitoSub: sub,
            email,
            clientId: payload.callerContext.clientId,
            lastEventType: payload.triggerSource,
            rawPayload: payload as unknown as object,
            events: {
              create: [
                {
                  id: eventId,
                  eventType: payload.triggerSource,
                  messageId,
                  rawPayload: payload as unknown as object,
                },
              ],
            },
          },
          update: {
            email,
            clientId: payload.callerContext.clientId,
            lastEventType: payload.triggerSource,
            rawPayload: payload as unknown as object,
            events: {
              create: [
                {
                  id: eventId,
                  eventType: payload.triggerSource,
                  messageId,
                  rawPayload: payload as unknown as object,
                },
              ],
            },
          },
        });
        return { status: "captured" };
      } catch (err) {
        // P2002 on the message_id unique index = this exact event was
        // already recorded (spec D4). Idempotent, not an error. Narrow
        // catch: confirm it is the message_id constraint, not some other
        // unique (e.g. the snapshot's own pkey or its cognito_sub unique
        // index), before treating it as a duplicate — otherwise re-throw.
        if (isMessageIdConflict(err)) return { status: "duplicate" };
        throw err;
      }
    });
  }
}
