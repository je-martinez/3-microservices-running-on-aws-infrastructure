"""`x-api-key` interceptor unit tests.

No database and no server here — these exercise the comparison and the metadata
extraction directly. The interceptor's behaviour *through a real server* (an actual
UNAUTHENTICATED status on the wire, and the fact that it guards all three RPCs) is
covered in `test_grpc_tracking.py`, which needs MySQL and skips without it. Keeping
the pure part separate means the auth logic is still verified on a machine with no
Floci running.
"""

from __future__ import annotations

import pytest

from src.shared.grpc.api_key_interceptor import (
    ApiKeyInterceptor,
    _extract_api_key,
    api_key_matches,
)

EXPECTED = "s3cret-internal-key"


class TestApiKeyMatches:
    def test_accepts_the_exact_key(self) -> None:
        assert api_key_matches(EXPECTED, EXPECTED) is True

    def test_rejects_a_wrong_key(self) -> None:
        assert api_key_matches("wrong-key-entirely", EXPECTED) is False

    def test_rejects_a_missing_key(self) -> None:
        """An absent header must take the same path as a wrong one."""
        assert api_key_matches(None, EXPECTED) is False

    def test_rejects_an_empty_key(self) -> None:
        assert api_key_matches("", EXPECTED) is False

    def test_rejects_a_correct_prefix(self) -> None:
        """The guard against a prefix-only match — the shape a timing attack builds."""
        assert api_key_matches(EXPECTED[:-1], EXPECTED) is False

    def test_rejects_a_longer_key_with_the_right_prefix(self) -> None:
        assert api_key_matches(EXPECTED + "x", EXPECTED) is False

    def test_is_case_sensitive(self) -> None:
        assert api_key_matches(EXPECTED.upper(), EXPECTED) is False

    def test_handles_non_ascii_without_raising(self) -> None:
        """`compare_digest` rejects non-ASCII `str`; we encode first, so this works."""
        assert api_key_matches("clé-secrète", EXPECTED) is False
        assert api_key_matches("clé-secrète", "clé-secrète") is True


class TestExtractApiKey:
    def test_finds_the_key(self) -> None:
        assert _extract_api_key((("x-api-key", EXPECTED),)) == EXPECTED

    def test_returns_none_when_absent(self) -> None:
        assert _extract_api_key((("user-agent", "grpc-python"),)) is None

    def test_returns_none_for_empty_metadata(self) -> None:
        assert _extract_api_key(()) is None
        assert _extract_api_key(None) is None

    def test_is_case_insensitive_on_the_metadata_name(self) -> None:
        """gRPC lowercases keys on the wire; be tolerant of a caller that didn't."""
        assert _extract_api_key((("X-Api-Key", EXPECTED),)) == EXPECTED

    def test_decodes_binary_values(self) -> None:
        assert _extract_api_key((("x-api-key", EXPECTED.encode()),)) == EXPECTED

    def test_first_occurrence_wins(self) -> None:
        """Matches Users' `metadata.get(...)[0]`, so both services agree."""
        assert (
            _extract_api_key((("x-api-key", EXPECTED), ("x-api-key", "second")))
            == EXPECTED
        )


class TestConstruction:
    def test_rejects_an_empty_expected_key(self) -> None:
        """A blank key would make every call match and open the whole server."""
        with pytest.raises(ValueError, match="must not be empty"):
            ApiKeyInterceptor("")
