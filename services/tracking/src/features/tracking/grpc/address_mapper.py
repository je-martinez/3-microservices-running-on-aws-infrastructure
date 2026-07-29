"""Mapping between the proto `Address` message and the stored JSON column.

Kept in its own module, out of the handlers, because the proto3-empty-string
question below is a *data* decision with downstream consequences, not handler
plumbing — and because the REST reads (Phase D) must render the same column back
out the same way.

## The decision: `""` is dropped, not stored

proto3 scalars have no null. An address line absent upstream arrives as `""`,
indistinguishable on the wire from one the user genuinely left blank — the .proto
says so explicitly ("Treat "" as 'not provided'").

So the stored JSON has a choice to make, and the two options are NOT equivalent:

  * **Store all six keys**, empty ones as `""` →
    `{"line1": "…", "line2": "", "city": "…", …}`. Every reader then has to know
    that `""` means absent, and every reader has to remember. A `line2` of `""`
    renders as a blank line in an address label; a `country` of `""` looks like a
    real value to anything doing `if address.get("country")` — which is the same
    trap, just moved.
  * **Omit empty keys** → `{"line1": "…", "city": "…", …}`. Absence in the JSON
    means absence, full stop. `address.get("line2")` returns `None`, which is
    Python's own "not there", and `json.dumps` of it reads honestly.

**We omit.** The stored document then says exactly what Orders knew, with no
sentinel value a reader can misread as data, and it round-trips cleanly: mapping
back to proto fills every missing key with `""` again (`to_proto` below), which is
precisely the value proto3 would have sent for it anyway. The conversion is
lossless in both directions *given* the .proto's own rule that `""` means absent.

The other consequence, and the reason to write it down: an address where every
field is empty maps to `{}` — and `{}` is stored as SQL NULL rather than an empty
JSON object, so `shipping_address IS NULL` covers both "no address message at all"
and "an address message carrying nothing". One representation for one meaning.

## PII

Never log the return value of anything here. The address is PII per
[[logging-context]], on the same footing as a plaintext email.
"""

from __future__ import annotations

from src.shared.grpc.generated import tracking_pb2

#: The address fields, in the .proto's declaration order. Named explicitly rather
#: than discovered by reflection (`DESCRIPTOR.fields`) so that adding a field to
#: the .proto is a deliberate, reviewable edit HERE too — reflection would silently
#: start persisting a new field into the JSON column with nobody having decided to.
ADDRESS_FIELDS: tuple[str, ...] = (
    "line1",
    "line2",
    "city",
    "state",
    "country",
    "postal_code",
)


def address_to_dict(address: tracking_pb2.Address) -> dict[str, str] | None:
    """Map the proto `Address` onto the JSON to persist, field by field.

    Explicitly field by field — not `MessageToDict`, which would couple the stored
    shape to protobuf's JSON conventions (it lowerCamelCases names, so `postal_code`
    would land as `postalCode` and disagree with the snake_case the rest of this
    service, and its db-naming convention, uses).

    Empty strings are dropped; see the module docstring. Returns None when nothing
    survives, so an all-empty address is stored as SQL NULL rather than `{}`.
    """
    mapped = {
        field: value
        for field in ADDRESS_FIELDS
        # proto3: an absent scalar reads as "", which the .proto defines as
        # "not provided". Dropping it here is the whole decision.
        if (value := getattr(address, field))
    }
    return mapped or None


def request_address_to_dict(
    request: tracking_pb2.CreateTrackingRequest,
) -> dict[str, str] | None:
    """Map a `CreateTracking` request's address, honoring message presence.

    A message field (unlike a scalar) DOES track presence in proto3, so
    `HasField` distinguishes "no `shipping_address` at all" from "an address whose
    fields are all empty". Both end up as None here — the two are the same fact
    about the shipment — but the check is written out because relying on
    `request.shipping_address` alone would silently construct a default message and
    hide that there was ever a difference.
    """
    if not request.HasField("shipping_address"):
        return None
    return address_to_dict(request.shipping_address)


def dict_to_address(stored: dict | None) -> tracking_pb2.Address:
    """Map the stored JSON back onto a proto `Address`.

    Missing keys become `""` — the value proto3 would have carried for them anyway
    — so a round trip through the database returns the caller the same message it
    sent. Unknown keys in the stored document are IGNORED rather than raising: this
    column is a snapshot written by past versions of this code, and a read must not
    start failing because an older row carries a field the .proto has since dropped.
    """
    if not stored:
        return tracking_pb2.Address()
    return tracking_pb2.Address(
        **{
            field: stored.get(field) or ""
            for field in ADDRESS_FIELDS
        }
    )
