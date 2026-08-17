"""The cross-service correlation id — `req_<nanoid>` — and its one trust rule.

The Python counterpart of Users' `shared/logging/request-id.ts`. Both implement
the same lifecycle from
`docs/superpowers/specs/2026-08-15-request-id-correlation-design.md`: honour an
inbound `x-request-id` when it is one of ours, otherwise mint a fresh one, and
never regenerate part-way through a request.

The id is deliberately NOT a second `trace_id`. It carries no tracing semantics
and needs no SDK, which is exactly why it exists: the runtimes at the ends of
these flows (the events-pipeline Lambda, the realtime WebSocket handlers) have
no OTel SDK at all, so `trace_id` is absent on precisely the hops where
reconstructing a flow end to end matters most.

Generation reuses `shared/db/nano_id.new_id`, the same helper that mints `trk_`
ids, and the validation pattern is DERIVED from `NanoIdConfig` rather than
written out: the format is `prefix_nanoid` per [[nano-id]], so there is no second
alphabet, no second dependency and no second notion of "how long an id is" to
keep in step.
"""

from __future__ import annotations

import re
from typing import Final

from src.shared.db.nano_id import NanoIdConfig

#: The header carrying the id between services, as BYTES.
#:
#: Bytes rather than `str` because the only consumer is `LogContextMiddleware`,
#: which reads headers straight off the raw ASGI scope as `(bytes, bytes)` pairs
#: — the same shape `USER_ID_HEADER` is declared in. Comparing a `str` constant
#: against a scope header would simply never match, silently discarding every
#: inbound id and making the correlation look "generated" at every hop.
REQUEST_ID_HEADER: Final[bytes] = b"x-request-id"

#: The `prefix_nanoid` prefix for a correlation id — see [[nano-id]].
REQUEST_ID_PREFIX: Final[str] = NanoIdConfig.REQUEST

#: `req_` followed by exactly `NanoIdConfig.LENGTH` characters of the service's
#: id alphabet (letters and digits only).
#:
#: DERIVED from the config, never written out: a hardcoded length or character
#: class would keep matching the previous format after the generator moved on,
#: and the failure is silent in the worst possible place — every one of our own
#: ids would be judged "not ours", discarded, and re-minted at each hop, so the
#: correlation breaks while every line still carries a plausible-looking id.
#:
#: `fullmatch` is used below rather than `match`, and the length is exact rather
#: than a bound, because this pattern is the ONLY thing standing between an
#: untrusted header and every log line the request produces.
REQUEST_ID_PATTERN: Final[re.Pattern[str]] = NanoIdConfig.pattern(REQUEST_ID_PREFIX)


def generate_request_id() -> str:
    """A fresh correlation id, e.g. `req_7gK3mP1vXz9wLq2bN8rRt4Yc`."""
    return NanoIdConfig.new_request_id()


def resolve_request_id(header_value: bytes | str | None) -> str:
    """The id for an inbound request: the caller's if ours, else a fresh one.

    Accepts `bytes` because that is what the ASGI scope yields, `str` for
    callers that already decoded, and `None` for the (common) case of no header
    at all. Anything else — a list, an int, whatever a future caller passes by
    mistake — takes the generate branch rather than raising: this function must
    not be able to fail a request (see below).

    WHY VALIDATE AT ALL. `x-request-id` is attacker-controlled input on any
    public endpoint, and by design its value is copied onto EVERY log line of
    the resulting flow and forwarded downstream over gRPC and SQS. That makes it
    the most pervasively-present field in the stream, so an unbounded string,
    a control character or a newline injected here does not contaminate one
    field on one line — it contaminates a whole flow's worth of records at once,
    in a field that log queries, dashboards and alerting rules all assume is
    well-formed. Accepting only our own shape is what keeps it trustworthy for
    the single job it has.

    WHY DISCARD SILENTLY INSTEAD OF ANSWERING 400. A correlation header is a
    convenience, never a contract the caller must satisfy to be served. The
    senders of a malformed value are misconfigured clients, header-mangling
    proxies and curious testers — none of whom asked for anything illegitimate.
    Failing their otherwise valid request would turn an observability aid into
    an outage, so the bad value is dropped and a fresh id generated as if the
    header had never been sent. The flow stays correlated end to end; it just
    is not correlated with the caller's id.
    """
    if isinstance(header_value, bytes):
        # latin-1 is the ASGI/HTTP header encoding and, unlike utf-8, cannot
        # raise on arbitrary bytes — a decode error here would be the 400 this
        # function exists to avoid. Anything it turns into that the pattern
        # dislikes is rejected a line later anyway.
        header_value = header_value.decode("latin-1")

    if isinstance(header_value, str) and REQUEST_ID_PATTERN.fullmatch(header_value):
        return header_value

    return generate_request_id()
