import { describe, expect, it, beforeEach } from "vitest";
import { SpanKind } from "@opentelemetry/api";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../src/generated/prisma/client.ts";
import { testSpanExporter } from "../../setup-tracing.ts";

// CONTRACT: Assert real spans, not that @prisma/instrumentation is INSTALLED — that
// passes even when it patches nothing, which is this mechanism's failure mode:
// registered after PrismaClient is constructed it yields zero spans, silently.
// No live database needed: the instrumentation wraps Prisma's ENGINE, not the socket,
// so the query spans are emitted on the way down even though the connection fails.
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
