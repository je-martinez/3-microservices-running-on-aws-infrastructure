"""Proto `Address` <-> stored JSON mapping.

Pure — no database. The persistence side of the same mapping (that the resulting
dict actually survives a round trip through the real MySQL JSON column) is covered
in `test_grpc_tracking.py`.

The decision under test is that an empty string means "not provided" and is
DROPPED from the stored document, never stored as `""`. See
`features/tracking/grpc/address_mapper.py` for why.
"""

from __future__ import annotations

from src.features.tracking.grpc.address_mapper import (
    ADDRESS_FIELDS,
    address_to_dict,
    dict_to_address,
    request_address_to_dict,
)
from src.shared.grpc.generated import tracking_pb2

FULL = {
    "line1": "742 Evergreen Terrace",
    "line2": "Apt 2",
    "city": "Springfield",
    "state": "OR",
    "country": "US",
    "postal_code": "97477",
}


def full_address() -> tracking_pb2.Address:
    return tracking_pb2.Address(**FULL)


class TestAddressToDict:
    def test_maps_every_field(self) -> None:
        assert address_to_dict(full_address()) == FULL

    def test_field_names_stay_snake_case(self) -> None:
        """Not `postalCode`: MessageToDict would lowerCamelCase it and disagree
        with the db-naming convention the rest of the service follows."""
        mapped = address_to_dict(full_address())
        assert mapped is not None
        assert "postal_code" in mapped
        assert "postalCode" not in mapped

    def test_drops_an_empty_field_rather_than_storing_it(self) -> None:
        """The core decision: `""` means absent, so the key is omitted."""
        address = full_address()
        address.line2 = ""
        mapped = address_to_dict(address)
        assert mapped is not None
        assert "line2" not in mapped
        # ...and the rest is untouched.
        assert mapped["line1"] == FULL["line1"]

    def test_drops_every_empty_field_independently(self) -> None:
        address = tracking_pb2.Address(line1="only this one")
        assert address_to_dict(address) == {"line1": "only this one"}

    def test_an_all_empty_address_maps_to_none(self) -> None:
        """None (SQL NULL), not `{}` — one representation for "no address"."""
        assert address_to_dict(tracking_pb2.Address()) is None

    def test_covers_exactly_the_protos_fields(self) -> None:
        """Guards the hand-maintained field tuple against the .proto drifting."""
        declared = {f.name for f in tracking_pb2.Address.DESCRIPTOR.fields}
        assert set(ADDRESS_FIELDS) == declared


class TestRequestAddressToDict:
    def test_maps_a_present_address(self) -> None:
        request = tracking_pb2.CreateTrackingRequest(
            order_id="ord_x", user_id="usr_y", shipping_address=full_address()
        )
        assert request_address_to_dict(request) == FULL

    def test_an_absent_address_message_is_none(self) -> None:
        """A message field DOES track presence in proto3, unlike a scalar."""
        request = tracking_pb2.CreateTrackingRequest(order_id="ord_x", user_id="usr_y")
        assert request.HasField("shipping_address") is False
        assert request_address_to_dict(request) is None

    def test_a_present_but_empty_address_is_also_none(self) -> None:
        request = tracking_pb2.CreateTrackingRequest(
            order_id="ord_x", user_id="usr_y", shipping_address=tracking_pb2.Address()
        )
        assert request.HasField("shipping_address") is True
        assert request_address_to_dict(request) is None


class TestDictToAddress:
    def test_restores_every_field(self) -> None:
        assert dict_to_address(FULL) == full_address()

    def test_missing_keys_come_back_as_empty_strings(self) -> None:
        """Exactly the value proto3 would have sent for them — lossless, given
        the .proto's own rule that `""` means not provided."""
        restored = dict_to_address({"line1": "742 Evergreen Terrace"})
        assert restored.line1 == "742 Evergreen Terrace"
        assert restored.line2 == ""
        assert restored.postal_code == ""

    def test_none_gives_an_empty_message(self) -> None:
        assert dict_to_address(None) == tracking_pb2.Address()

    def test_ignores_unknown_stored_keys(self) -> None:
        """An older row carrying a since-removed field must not break a read."""
        restored = dict_to_address({"line1": "a", "legacy_field": "b"})
        assert restored.line1 == "a"

    def test_tolerates_a_null_value_in_the_stored_document(self) -> None:
        assert dict_to_address({"line1": None}).line1 == ""


class TestRoundTrip:
    def test_full_address_survives_both_directions(self) -> None:
        assert dict_to_address(address_to_dict(full_address())) == full_address()

    def test_partial_address_survives_both_directions(self) -> None:
        """The empty fields come back empty — which is what was sent."""
        original = tracking_pb2.Address(
            line1="742 Evergreen Terrace", city="Springfield"
        )
        assert dict_to_address(address_to_dict(original)) == original
