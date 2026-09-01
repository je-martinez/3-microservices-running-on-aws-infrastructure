import { test, expect } from "@playwright/test";
import { apiClient, trackingClient } from "../support/api-client.js";
import { carrierHeaders } from "../support/tracking-carrier-key.js";
import { makeUser } from "../support/chance-factory.js";

// Internal layer-2 Tracking specs — faked x-user-id, state machine guards.
// WHY: usr_ id works as x-user-id here (init-tracking resolves via gRPC) but
// ownership by cognito_sub is only testable at gateway (tests/gateway/tracking.spec.ts).
// Tracking rows accumulate locally — each test uses its own synthetic order id.

//: The forward-only progression from the design.
const PROGRESSION = [
  "PLACED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
] as const;

type TrackingPayload = {
  id: string;
  user_id: string;
  order_id: string;
  status: string;
  datetime: string;
  history: { tracking_id: string; user_id: string; order_id: string; status: string }[];
};

// Registers a user against the Users service and returns the `usr_` id, used as the
// faked `x-user-id`. Same helper shape as orders.spec.ts's registerCaller().
async function registerCaller(): Promise<string> {
  const users = await apiClient();
  const res = await users.post("/v1/users/register", { data: makeUser() });
  expect(res.status(), `register failed: ${await res.text()}`).toBe(201);
  const { id } = await res.json();
  return id as string;
}

// Synthetic order id for Tracking-only tests (init-tracking does not validate existence).
function syntheticOrderId(): string {
  const suffix = Math.random().toString(36).slice(2, 12);
  return `ord_e2e${suffix}`.slice(0, 21);
}

// TestMode off — x-test-mode not sent; tracking stays at PLACED until carrier PUT.
async function createTracking(
  api: Awaited<ReturnType<typeof trackingClient>>,
  userId: string,
): Promise<{ orderId: string; tracking: TrackingPayload }> {
  const orderId = syntheticOrderId();
  const res = await api.post("/v1/trackings/init-tracking", {
    headers: { "x-user-id": userId },
    data: { order_id: orderId, shipping_address: { line1: "1 Test St", city: "Austin" } },
  });
  expect(res.status(), `init-tracking failed: ${await res.text()}`).toBe(201);
  const body = await res.json();
  return { orderId, tracking: body.tracking as TrackingPayload };
}

// Drives a status change as the carrier: API key only, and no `x-user-id` at all.
// The absence is deliberate and asserted-by-construction — this endpoint's gateway
// route is `auth = false`, so it never receives one, and a handler that started
// requiring it would 401 every real carrier.
async function carrierPut(
  api: Awaited<ReturnType<typeof trackingClient>>,
  orderId: string,
  status: string,
) {
  return api.put(`/v1/trackings/${orderId}/status`, {
    headers: carrierHeaders(),
    data: { status },
  });
}

test("GET /v1/health is public and returns 200 with no auth", async () => {
  const api = await trackingClient();
  // Served UNPREFIXED internally. The gateway publishes it as
  // /v1/tracking/health and nginx rewrites down to this path — see health_router.py.
  const res = await api.get("/v1/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("GET /v1/trackings/{orderId} without x-user-id returns 401", async () => {
  const api = await trackingClient();
  const res = await api.get("/v1/trackings/ord_doesnotexist");
  expect(res.status()).toBe(401);
});

test("GET /v1/trackings (batch) without x-user-id returns 401", async () => {
  const api = await trackingClient();
  const res = await api.get("/v1/trackings?order_ids=ord_doesnotexist");
  expect(res.status()).toBe(401);
});

test("POST /v1/trackings/init-tracking without x-user-id returns 401", async () => {
  const api = await trackingClient();
  const res = await api.post("/v1/trackings/init-tracking", {
    data: { order_id: syntheticOrderId() },
  });
  expect(res.status()).toBe(401);
});

test("POST /v1/trackings/init-tracking creates the tracking at PLACED and the read round-trips it", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const { orderId, tracking } = await createTracking(api, userId);

  expect(tracking.id).toMatch(/^trk_/);
  expect(tracking.order_id).toBe(orderId);
  // The internal `usr_` id, resolved from the header through Users' gRPC — not the
  // header value echoed back (which happens to be the same string at this layer;
  // the gateway spec is where that distinction is testable).
  expect(tracking.user_id).toBe(userId);
  expect(tracking.status).toBe("PLACED");
  // One history row at creation: the design's t=0 entry.
  expect(tracking.history).toHaveLength(1);
  expect(tracking.history[0]).toMatchObject({
    tracking_id: tracking.id,
    order_id: orderId,
    user_id: userId,
    status: "PLACED",
  });

  const fetched = await api.get(`/v1/trackings/${orderId}`, {
    headers: { "x-user-id": userId },
  });
  expect(fetched.status()).toBe(200);
  const reread = (await fetched.json()) as TrackingPayload;
  expect(reread.id).toBe(tracking.id);
  expect(reread.status).toBe("PLACED");
  expect(reread.history).toHaveLength(1);

  // The shipping address is stored but exposed on NO surface — it is PII, and the
  // narrowest response that answers "where is my shipment" is the one that cannot
  // leak it (schemas.py). Asserted so a future field addition has to be deliberate.
  expect(reread).not.toHaveProperty("shipping_address");
  expect(reread.history[0]).not.toHaveProperty("shipping_address");
});

test("POST /v1/trackings/init-tracking a second time for the same order returns 409", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const { orderId } = await createTracking(api, userId);

  const conflict = await api.post("/v1/trackings/init-tracking", {
    headers: { "x-user-id": userId },
    data: { order_id: orderId },
  });
  expect(conflict.status()).toBe(409);
  // Nested under `detail` — FastAPI's HTTPException contract for a structured
  // detail, unlike the carrier PUT's flat body (init_tracking_router._error).
  expect((await conflict.json()).detail.reason).toBe("tracking_already_exists");
});

test("POST /v1/trackings/init-tracking with identity in the body returns 422", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  // `extra="forbid"` on InitTrackingRequest: a client sending `user_id` gets a 422
  // naming the field rather than having it silently ignored. The body is client
  // input; identity is a gateway assertion and must never be accepted from it.
  const res = await api.post("/v1/trackings/init-tracking", {
    headers: { "x-user-id": userId },
    data: { order_id: syntheticOrderId(), user_id: "usr_someoneelse" },
  });
  expect(res.status()).toBe(422);
});

test("GET /v1/trackings/{orderId} for an unknown order returns 404", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const res = await api.get("/v1/trackings/ord_doesnotexist", {
    headers: { "x-user-id": userId },
  });
  expect(res.status()).toBe(404);
});

test("GET /v1/trackings (batch) returns the caller's trackings and omits unknown ids", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const first = await createTracking(api, userId);
  const second = await createTracking(api, userId);

  const res = await api.get(
    `/v1/trackings?order_ids=${first.orderId},${second.orderId},ord_doesnotexist`,
    { headers: { "x-user-id": userId } },
  );
  // 200 with the found subset — never an error for the id that does not exist.
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.trackings)).toBe(true);
  expect(body.trackings).toHaveLength(2);
  const ids = body.trackings.map((t: TrackingPayload) => t.order_id).sort();
  expect(ids).toEqual([first.orderId, second.orderId].sort());
  // Each entry carries its own history, same shape as the single read.
  for (const item of body.trackings as TrackingPayload[]) {
    expect(item.history).toHaveLength(1);
    expect(item.history[0].status).toBe("PLACED");
  }
});

test("GET /v1/trackings (batch) with only unknown ids is 200 with an empty list", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const res = await api.get("/v1/trackings?order_ids=ord_nope1,ord_nope2", {
    headers: { "x-user-id": userId },
  });
  expect(res.status()).toBe(200);
  expect((await res.json()).trackings).toEqual([]);
});

test("GET /v1/trackings (batch) rejects more than 100 order_ids with 400", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  // MAX_BATCH_ORDER_IDS = 100 in trackings_router.py. The bound is not caution for
  // its own sake: `order_ids` lands in a `WHERE order_id IN (...)`, so an unbounded
  // list lets one request build an arbitrarily large query.
  const tooMany = Array.from({ length: 101 }, (_, i) => `ord_x${i}`).join(",");
  const res = await api.get(`/v1/trackings?order_ids=${tooMany}`, {
    headers: { "x-user-id": userId },
  });
  expect(res.status()).toBe(400);

  // Exactly 100 is allowed — the check is `> MAX`, so the boundary itself must pass.
  const atLimit = Array.from({ length: 100 }, (_, i) => `ord_x${i}`).join(",");
  const ok = await api.get(`/v1/trackings?order_ids=${atLimit}`, {
    headers: { "x-user-id": userId },
  });
  expect(ok.status()).toBe(200);
});

test("GET /v1/trackings (batch) without the order_ids parameter is 422", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  // `order_ids` is a required Query param with no default, so FastAPI rejects the
  // request before the handler runs. 422 (not 400) because this is request-shape
  // validation, unlike the over-limit case above which the handler decides.
  const res = await api.get("/v1/trackings", { headers: { "x-user-id": userId } });
  expect(res.status()).toBe(422);
});

// The internal echo of the gateway's ownership test. Weaker by construction — both
// identities here are `usr_` ids we chose, not verified Cognito subs — but it still
// pins the 404-not-403 contract at this layer, and it uses TWO DIFFERENT values,
// which is the minimum bar for an ownership assertion in this service
// (services/tracking/CLAUDE.md §5b). The gateway spec is what proves the filter
// reads the right claim.
test("GET /v1/trackings/{orderId} for another caller's tracking is 404, not 403", async () => {
  const api = await trackingClient();
  const owner = await registerCaller();
  const other = await registerCaller();
  expect(other).not.toBe(owner);

  const { orderId } = await createTracking(api, owner);

  // The owner can read it — without this, a 404 for `other` would prove nothing,
  // since a filter matching nobody 404s everyone including the rightful owner.
  const asOwner = await api.get(`/v1/trackings/${orderId}`, {
    headers: { "x-user-id": owner },
  });
  expect(asOwner.status()).toBe(200);

  const asOther = await api.get(`/v1/trackings/${orderId}`, {
    headers: { "x-user-id": other },
  });
  expect(asOther.status()).toBe(404);
  expect(asOther.status()).not.toBe(403);

  // The batch read applies the same rule by omission rather than by status code.
  const batch = await api.get(`/v1/trackings?order_ids=${orderId}`, {
    headers: { "x-user-id": other },
  });
  expect(batch.status()).toBe(200);
  expect((await batch.json()).trackings).toEqual([]);
});

// --- the carrier PUT and the state machine ---------------------------------

test("PUT /v1/trackings/{orderId}/status advances one step and appends to history", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const { orderId, tracking } = await createTracking(api, userId);

  const res = await carrierPut(api, orderId, "PROCESSING");
  expect(res.status(), `carrier PUT failed: ${await res.text()}`).toBe(200);
  const updated = (await res.json()) as TrackingPayload;
  expect(updated.id).toBe(tracking.id);
  expect(updated.status).toBe("PROCESSING");
  // Appended, not replaced — Tracking_History is immutable.
  expect(updated.history.map((h) => h.status)).toEqual(["PLACED", "PROCESSING"]);
});

test("PUT /v1/trackings/{orderId}/status may skip ahead, as long as it moves forward", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const { orderId } = await createTracking(api, userId);

  // PLACED → DELIVERED skips three statuses. The guard is "strictly forward", not
  // "exactly the next one" — a carrier that only reports the final delivery is a
  // legitimate caller, so skipping is allowed and only backward/equal is rejected.
  const res = await carrierPut(api, orderId, "DELIVERED");
  expect(res.status()).toBe(200);
  const updated = (await res.json()) as TrackingPayload;
  expect(updated.status).toBe("DELIVERED");
  expect(updated.history.map((h) => h.status)).toEqual(["PLACED", "DELIVERED"]);
});

test("PUT /v1/trackings/{orderId}/status rejects the SAME status with 400 not_strictly_forward", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const { orderId } = await createTracking(api, userId);

  // PLACED → PLACED. Rejected because a repeat writes a duplicate history row for
  // a transition that did not happen — and the (tracking_id, status) composite PK
  // could not hold it anyway.
  const res = await carrierPut(api, orderId, "PLACED");
  expect(res.status()).toBe(400);
  const body = await res.json();
  // Flat `reason`, top-level — the carrier PUT uses RejectedStatusUpdate with its
  // own handler precisely so a client does not have to reach into `detail`.
  expect(body.reason).toBe("not_strictly_forward");
  expect(body.detail).toContain("PLACED");
});

test("PUT /v1/trackings/{orderId}/status rejects a BACKWARD move with 400 backward_transition", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const { orderId } = await createTracking(api, userId);

  expect((await carrierPut(api, orderId, "OUT_FOR_DELIVERY")).status()).toBe(200);

  // OUT_FOR_DELIVERY → PROCESSING. A distinct reason from `not_strictly_forward`:
  // "you went backwards" and "you did not move" are different carrier mistakes and
  // a client should be able to tell them apart without parsing prose.
  const res = await carrierPut(api, orderId, "PROCESSING");
  expect(res.status()).toBe(400);
  expect((await res.json()).reason).toBe("backward_transition");
});

test("PUT /v1/trackings/{orderId}/status on a DELIVERED tracking is 400 already_delivered", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const { orderId } = await createTracking(api, userId);

  expect((await carrierPut(api, orderId, "DELIVERED")).status()).toBe(200);

  // DELIVERED is terminal: it rejects EVERY update, and with its own reason rather
  // than `backward_transition`. That distinction is the point — "this shipment is
  // closed" is permanent, while a backward move on a live tracking is a correctable
  // mistake, and a retrying carrier needs to know which it hit.
  const repeat = await carrierPut(api, orderId, "DELIVERED");
  expect(repeat.status()).toBe(400);
  expect((await repeat.json()).reason).toBe("already_delivered");

  const backward = await carrierPut(api, orderId, "SHIPPED");
  expect(backward.status()).toBe(400);
  expect((await backward.json()).reason).toBe("already_delivered");

  // And nothing was written by either rejection: still DELIVERED, still exactly the
  // two history rows this test created.
  const after = await api.get(`/v1/trackings/${orderId}`, {
    headers: { "x-user-id": userId },
  });
  const reread = (await after.json()) as TrackingPayload;
  expect(reread.status).toBe("DELIVERED");
  expect(reread.history).toHaveLength(2);
});

test("PUT /v1/trackings/{orderId}/status with a status outside the enum is 400 invalid_status", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const { orderId } = await createTracking(api, userId);

  // 400 not 422 — status is plain string so all rejection reasons share shape.
  const res = await carrierPut(api, orderId, "LOST_IN_SPACE");
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.reason).toBe("invalid_status");
  // The message enumerates the valid values, so a carrier can self-correct.
  for (const valid of PROGRESSION) expect(body.detail).toContain(valid);
});

test("PUT /v1/trackings/{orderId}/status for an unknown order is 404, not 400", async () => {
  const api = await trackingClient();
  // 404 and 400 mean different things to a retrying carrier: 404 says "no tracking
  // exists yet, retrying may help once one does", while 400 says "it exists and
  // refused the move, retrying the same status never helps".
  const res = await carrierPut(api, "ord_doesnotexist", "DELIVERED");
  expect(res.status()).toBe(404);
});

test("PUT /v1/trackings/{orderId}/status with a wrong or missing API key is 401", async () => {
  const api = await trackingClient();
  const userId = await registerCaller();
  const { orderId } = await createTracking(api, userId);

  const wrong = await api.put(`/v1/trackings/${orderId}/status`, {
    headers: { "x-api-key": "definitely-not-the-carrier-key" },
    data: { status: "PROCESSING" },
  });
  expect(wrong.status()).toBe(401);

  const missing = await api.put(`/v1/trackings/${orderId}/status`, {
    data: { status: "PROCESSING" },
  });
  expect(missing.status()).toBe(401);

  // Authenticated before anything is read, so neither attempt touched the tracking:
  // a body that WOULD have been accepted was rejected before the handler saw it, so
  // the tracking is still at the status creation left it.
  const after = await api.get(`/v1/trackings/${orderId}`, {
    headers: { "x-user-id": userId },
  });
  expect((await after.json()).status).toBe("PLACED");
});

test("the carrier PUT needs NO x-user-id — an unrelated caller's key still works", async () => {
  const api = await trackingClient();
  const owner = await registerCaller();
  const { orderId } = await createTracking(api, owner);

  // No `x-user-id` header at all, and the tracking belongs to `owner`. This must
  // still succeed: the endpoint identifies the tracking by order_id ALONE and must
  // never reuse the reads' ownership filter — doing so would 404 every real carrier
  // call while looking correctly implemented (carrier_router.py).
  const res = await carrierPut(api, orderId, "PROCESSING");
  expect(res.status(), `carrier PUT failed: ${await res.text()}`).toBe(200);
  expect((await res.json()).status).toBe("PROCESSING");

  // The owner sees the carrier's update on their own scoped read — one record, two
  // surfaces, no drift.
  const asOwner = await api.get(`/v1/trackings/${orderId}`, {
    headers: { "x-user-id": owner },
  });
  expect(asOwner.status()).toBe(200);
  expect((await asOwner.json()).status).toBe("PROCESSING");
});
