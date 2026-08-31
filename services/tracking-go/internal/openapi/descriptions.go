package openapi

// The prose the document carries, held apart from the structure so paths() stays
// readable enough to audit against the route table.
//
// # Reproduced VERBATIM from the Python contract, Python idioms included
//
// Two of these descriptions name things this runtime does not have: `async def`
// versus a plain `def`, pymysql being a blocking driver, a generator dependency
// owning the commit. Rewriting them to talk about Go would be an honest-looking
// change and a WRONG one. This document is the contract consumers already import,
// a reworded description is a diff every one of them sees, and the equivalence
// gate would have to absorb it into the allowlist to stay green -- which is
// exactly the kind of entry that turns a closed list into a growing one.
//
// The prose describes how the SERVICE behaves at its edge, and that is identical;
// only the internal mechanics it cites are Python's, and those were never the
// contract. Refreshing this prose once the Python implementation is retired is a
// deliberate contract change with its own diff, not a side effect of the
// migration.

const healthDescription = "Return `200 {\"status\": \"ok\"}`.\n" +
	"\n" +
	"`async def` is correct here precisely because there is nothing blocking to do —\n" +
	"no session, no query. Every other handler in this service is a plain `def`,\n" +
	"since pymysql is a blocking driver."

const e2eCleanupDescription = "Soft-delete every live tracking tagged as an E2E fixture.\n" +
	"\n" +
	"The **write** session, not the read one: this mutates. Its generator\n" +
	"dependency owns the commit, so the stamps land during teardown after this\n" +
	"returns — a raise here leaves nothing behind.\n" +
	"\n" +
	"No `cognito_sub` on the log line: there is no caller identity on this request,\n" +
	"and the convention omits unknown fields rather than emitting null."

const initTrackingDescription = "Create a tracking at `PLACED` with its first history row, in one transaction.\n" +
	"\n" +
	"The whole blocking part — the Users gRPC resolution and both INSERTs — runs in\n" +
	"one `asyncio.to_thread` call rather than two. Splitting them would hop threads\n" +
	"twice for no benefit, and would put the resolution outside the block the write\n" +
	"session covers.\n" +
	"\n" +
	"Never logs `payload.shipping_address`: it is PII ([[logging-context]]). The\n" +
	"success line carries `order_id`, `user_id`, `cognito_sub` and `tracking_id`,\n" +
	"all of which are shared-context fields."

const listTrackingsDescription = "Return the caller's trackings among `order_ids`, each with its history.\n" +
	"\n" +
	"Always `200`, even when nothing matches: \"none of these are yours\" is a\n" +
	"complete answer to the question asked, not a failure. An empty list is the\n" +
	"correct body, and it is deliberately indistinguishable from \"none of these\n" +
	"exist\" — see the ownership rule in the module docstring."

const getTrackingDescription = "Return one of the caller's trackings with its history, or `404`.\n" +
	"\n" +
	"The `404` covers both \"no such tracking\" and \"belongs to another user\" — the\n" +
	"two are the same answer by design. The failure is logged with the machine-\n" +
	"readable `reason` the logging convention requires; `order_id` and\n" +
	"`cognito_sub` are part of the shared context and are safe to log, unlike the\n" +
	"shipping address, which this surface does not even carry."

const carrierDescription = "Advance a tracking's status and append the transition to its history.\n" +
	"\n" +
	"The three failure modes map to distinct codes so a carrier can tell them apart\n" +
	"without parsing prose: `404` means the order has no tracking (retrying will not\n" +
	"help until one exists), while `400` means the tracking is there and refused the\n" +
	"move (retrying with the SAME status will never help — the state machine is\n" +
	"forward-only).\n" +
	"\n" +
	"Both `400` paths carry a machine-readable `reason`, and both log a\n" +
	"`*_failed` event with that same token, per the logging convention. The\n" +
	"shipping address is never touched or logged here — it is PII and a status\n" +
	"update has no business with it."

// orderIDsDescription appears TWICE in the document -- once on the parameter
// and once inside its schema -- because FastAPI copies a Query description to
// both. Reproduced rather than deduplicated: a consumer generating a client
// may read either one.
const orderIDsDescription = "Comma-separated order ids, e.g. `ord_a,ord_b`. Ids the caller does not own are omitted from the response."
