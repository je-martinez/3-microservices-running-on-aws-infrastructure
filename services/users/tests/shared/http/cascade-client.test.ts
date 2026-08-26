import { describe, it, expect, vi, afterEach } from "vitest";
import { CascadeClient, CascadeFailedError } from "#shared/http/cascade-client";

const ORDERS = "http://orders:8080";
const TRACKING = "http://tracking:8000";
const KEY = "internal-key";

function makeClient(fetchImpl: typeof fetch) {
  return new CascadeClient({
    ordersBaseUrl: ORDERS,
    trackingBaseUrl: TRACKING,
    apiKey: KEY,
    fetchImpl,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("CascadeClient", () => {
  it("calls Orders with the internal key and BOTH identities in the body", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await makeClient(fetchImpl as any).deleteOrdersForUser("sub-1", "usr_1");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORDERS}/v1/orders/by-user`);
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    // camelCase for Orders; both ids because `cognito_sub` is not the durable
    // identity — a re-registered user gets a new one, `usr_` ids never change.
    expect(JSON.parse(init.body as string)).toEqual({ cognitoSub: "sub-1", userId: "usr_1" });
  });

  it("refuses to send an empty identity to either service", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    // An empty value would widen the downstream `cognito_sub OR user_id` match if
    // any row ever carried an empty string in the same column. Nothing is sent.
    await expect(
      makeClient(fetchImpl as any).deleteOrdersForUser("", "usr_1"),
    ).rejects.toBeInstanceOf(CascadeFailedError);
    await expect(
      makeClient(fetchImpl as any).deleteTrackingsForUser("sub-1", ""),
    ).rejects.toBeInstanceOf(CascadeFailedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls Tracking with BOTH identities, snake_cased", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await makeClient(fetchImpl as any).deleteTrackingsForUser("sub-1", "usr_1");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${TRACKING}/v1/trackings/by-user`);
    // Both identities, because Tracking's cognito_sub is nullable on legacy rows.
    // Dropping user_id here would leave a returning user's oldest trackings live.
    expect(JSON.parse(init.body as string)).toEqual({
      cognito_sub: "sub-1",
      user_id: "usr_1",
    });
  });

  it("throws CascadeFailedError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));

    await expect(
      makeClient(fetchImpl as any).deleteOrdersForUser("sub-1", "usr_1"),
    ).rejects.toBeInstanceOf(CascadeFailedError);
  });

  it("throws CascadeFailedError when the request never completes", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    // A network failure must be indistinguishable from a 500 to the caller: both
    // mean "this leg did not confirm", and both must stop the deletion.
    await expect(
      makeClient(fetchImpl as any).deleteTrackingsForUser("sub-1", "usr_1"),
    ).rejects.toBeInstanceOf(CascadeFailedError);
  });

  it("names the failing service on the error, so a 502 is diagnosable", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));

    const error = await makeClient(fetchImpl as any)
      .deleteOrdersForUser("sub-1", "usr_1")
      .catch((e) => e as CascadeFailedError);

    expect(error.service).toBe("orders");
  });

  it("never puts the api key in the error message", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));

    const error = await makeClient(fetchImpl as any)
      .deleteOrdersForUser("sub-1", "usr_1")
      .catch((e) => e as CascadeFailedError);

    // The error travels into logs and, in shape, toward the client. The key must
    // not ride along with it.
    expect(error.message).not.toContain(KEY);
  });
});
