import { describe, expect, it, beforeEach } from "vitest";
import { SpanKind } from "@opentelemetry/api";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../src/generated/prisma/client.ts";
import { testSpanExporter } from "../../setup-tracing.ts";

// Proves the DB layer actually produces spans — asserting that
// @prisma/instrumentation is merely INSTALLED would pass even when it patches
// nothing, which is precisely this mechanism's failure mode: register it after
// PrismaClient is constructed and you get zero spans, silently, with no error.
// (Confirmed by a negative control while writing this: with the registration
// removed, the query below emits 0 spans instead of 5.)
//
// No live database is needed. The instrumentation wraps Prisma's ENGINE, not
// the socket, so the query spans — including the CLIENT `db_query` span — are
// emitted on the way down and exist even though the connection then fails.
// That keeps this a plain unit test while still exercising the real client
// rather than a mock. src/generated/prisma is imported directly instead of
// through shared/db/prisma.ts because the latter builds its client from env
// config at module load and pulls in read-replica routing this does not need.
registerInstrumentations({ instrumentations: [new PrismaInstrumentation()] });

const UNREACHABLE_DB = "postgres://user:pass@127.0.0.1:59999/nonexistent";

beforeEach(() => {
  testSpanExporter.reset();
});

describe("Prisma instrumentation", () => {
  it("emits spans for a real Prisma query, including a CLIENT db_query span", async () => {
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: UNREACHABLE_DB }),
    });

    await expect(client.user.findMany({ take: 1 })).rejects.toThrow();

    const names = testSpanExporter.getFinishedSpans().map((span) => span.name);
    expect(names).toContain("prisma:client:operation");
    expect(names).toContain("prisma:client:db_query");

    const dbQuery = testSpanExporter
      .getFinishedSpans()
      .find((span) => span.name === "prisma:client:db_query");
    expect(dbQuery!.kind).toBe(SpanKind.CLIENT);
  });
});
