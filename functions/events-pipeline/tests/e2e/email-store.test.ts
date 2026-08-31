import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "mongodb";

// FILE-WIDE and BEFORE the import below: the store imports #shared/config/env,
// which Zod-parses process.env at module load (ADR-0014). Without these the
// suite fails to load at all, with a ZodError about DOCDB_HOST rather than
// anything to do with the store. Same pattern as tests/handler.test.ts.
vi.stubEnv("DOCDB_HOST", "docdb-test");
vi.stubEnv("DOCDB_USERNAME", "docdb-test");
vi.stubEnv("DOCDB_PASSWORD", "docdb-test");
vi.stubEnv("SES_FROM_ADDRESS", "no-reply@3mrai.local");
vi.stubEnv("ASSETS_BASE_URL", "http://localhost:4566/assets");

const { E2eEmailStore, ensureE2eIndexes } = await import("#e2e/email-store");

const insertOne = vi.fn(async () => ({ acknowledged: true }));
const createIndex = vi.fn(async () => "idx");
const toArray = vi.fn(async () => []);
const limit = vi.fn(() => ({ toArray }));
const sort = vi.fn(() => ({ limit }));
const find = vi.fn(() => ({ sort }));

const db = {
  collection: vi.fn(() => ({ insertOne, createIndex, find })),
} as unknown as Db;

const input = {
  run_id: "run_abc",
  to: "e2e+uuid@example.com",
  subject: "Your one-time code",
  template_key: "auth-otp",
  html: "<html>123456</html>",
  code: "123456",
  event_id: "evt_abc",
  trace_id: "1fe7e1b6afff0da2990ff65247a85ee2",
};

beforeEach(() => vi.clearAllMocks());

describe("ensureE2eIndexes", () => {
  it("creates a TTL index that expires documents at expires_at", async () => {
    await ensureE2eIndexes(db);
    // expireAfterSeconds: 0 means "expire AT the date in this field", which is
    // what lets each document carry its own lifetime.
    expect(createIndex).toHaveBeenCalledWith({ expires_at: 1 }, { expireAfterSeconds: 0 });
  });

  it("creates the query index the HTTP route actually uses", async () => {
    await ensureE2eIndexes(db);
    expect(createIndex).toHaveBeenCalledWith({ run_id: 1, to: 1 });
  });
});

describe("E2eEmailStore.record", () => {
  it("stamps created_at and derives expires_at from the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00.000Z"));
    await new E2eEmailStore(db).record(input);
    const [doc] = insertOne.mock.calls[0] as unknown as [Record<string, Date>];
    expect(doc.created_at).toEqual(new Date("2026-08-29T12:00:00.000Z"));
    // Default E2E_EMAIL_TTL_SECONDS is 3600.
    expect(doc.expires_at).toEqual(new Date("2026-08-29T13:00:00.000Z"));
    vi.useRealTimers();
  });

  it("rejects a record that does not satisfy the schema", async () => {
    // The store validates rather than trusting its caller: a malformed document
    // in this collection would fail at QUERY time, in a test, far from here.
    await expect(new E2eEmailStore(db).record({ ...input, to: "not-an-email" })).rejects.toThrow();
    expect(insertOne).not.toHaveBeenCalled();
  });
});

describe("E2eEmailStore.query", () => {
  it("always scopes by run_id, so one run cannot see another's mail", async () => {
    await new E2eEmailStore(db).query({ runId: "run_abc" });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ run_id: "run_abc" }));
  });

  it("adds recipient and template to the filter when given", async () => {
    await new E2eEmailStore(db).query({ runId: "run_abc", to: "a@b.com", templateKey: "auth-otp" });
    expect(find).toHaveBeenCalledWith({ run_id: "run_abc", to: "a@b.com", template_key: "auth-otp" });
  });

  it("returns newest first and caps the result set", async () => {
    await new E2eEmailStore(db).query({ runId: "run_abc" });
    expect(sort).toHaveBeenCalledWith({ created_at: -1 });
    expect(limit).toHaveBeenCalledWith(50);
  });

  it("never returns more than the hard cap even when asked for more", async () => {
    // A caller asking for 10000 would otherwise stream the whole collection
    // through a Lambda response.
    await new E2eEmailStore(db).query({ runId: "run_abc", limit: 10_000 });
    expect(limit).toHaveBeenCalledWith(200);
  });
});
