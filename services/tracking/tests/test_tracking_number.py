"""`new_tracking_number()` — the customer-facing shipment number generator.

Pure unit tests: no database, no queue. The persistence side (the column, the
NOT NULL, the unique index, the value surviving a round trip through MySQL) is
covered in `test_repository.py`; what is pinned here is the value's SHAPE and
the source of its randomness.

## Why the source of randomness is asserted at all

`random` and `secrets` produce output that looks identical. The difference is
that `random` is a Mersenne Twister seeded from the clock — observing a handful
of outputs reconstructs its state and predicts every subsequent one — while
`secrets` reads the OS CSPRNG. A tracking number is quoted in an email and will
appear in URLs, so a predictable one lets somebody enumerate other people's
shipments.

That is not a property any output can demonstrate: 60 bits of Mersenne Twister
and 60 bits of urandom are equally uniform-looking. So it is asserted the only
way it can be — by pinning WHICH module the generator draws from.
"""

from __future__ import annotations

import re

import pytest

from src.shared.db import tracking_number as module
from src.shared.db.tracking_number import (
    GROUP_COUNT,
    GROUP_SIZE,
    TRACKING_NUMBER_ALPHABET,
    TRACKING_NUMBER_LENGTH,
    TRACKING_NUMBER_PREFIX,
    new_tracking_number,
)

#: The full rendered shape, as a regex, written out rather than assembled from
#: the constants: a test that rebuilt the pattern from the same constants the
#: implementation uses would agree with any format either of them drifted into.
FORMAT = re.compile(r"3MRAI-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}")


class TestTheFormat:
    def test_it_matches_the_documented_shape(self) -> None:
        assert FORMAT.fullmatch(new_tracking_number())

    def test_the_shape_holds_across_many_draws(self) -> None:
        """One draw omits most of the alphabet by chance; a single match says
        little about a generator that occasionally emits a wrong-length group.
        """
        assert all(FORMAT.fullmatch(new_tracking_number()) for _ in range(500))

    def test_it_carries_the_3mrai_prefix(self) -> None:
        """The prefix names the issuing system. A tracking row is created at
        PLACED, before any carrier exists, so this number is ours — and a real
        carrier's number, should one ever be recorded, is never mistaken for
        it."""
        assert new_tracking_number().startswith(f"{TRACKING_NUMBER_PREFIX}-")

    def test_it_is_the_declared_length(self) -> None:
        """`TRACKING_NUMBER_LENGTH` sizes the VARCHAR. If the two disagreed,
        MySQL would truncate every number — silently, in non-strict mode."""
        assert len(new_tracking_number()) == TRACKING_NUMBER_LENGTH

    def test_it_has_three_groups_of_four(self) -> None:
        prefix, *groups = new_tracking_number().split("-")

        assert prefix == TRACKING_NUMBER_PREFIX
        assert len(groups) == GROUP_COUNT
        assert all(len(group) == GROUP_SIZE for group in groups)

    def test_it_is_uppercase(self) -> None:
        """Case is not information here: a reader typing it back in will not
        preserve it, so the stored value must be the one canonical spelling."""
        number = new_tracking_number()

        assert number == number.upper()


class TestTheAlphabet:
    def test_every_character_comes_from_the_alphabet(self) -> None:
        drawn = {
            character
            for _ in range(500)
            for character in new_tracking_number().removeprefix("3MRAI-").replace("-", "")
        }

        assert drawn <= set(TRACKING_NUMBER_ALPHABET)

    def test_the_whole_alphabet_is_reachable(self) -> None:
        """The other direction: a generator that only ever emitted a subset
        would satisfy the test above while quietly having far less entropy than
        the docstring claims."""
        drawn = {
            character
            for _ in range(500)
            for character in new_tracking_number().removeprefix("3MRAI-").replace("-", "")
        }

        assert drawn == set(TRACKING_NUMBER_ALPHABET)

    @pytest.mark.parametrize("confusable", ["I", "O", "0", "1"])
    def test_the_confusable_characters_are_excluded(self, confusable: str) -> None:
        """`I`/`1` and `O`/`0` are the pairs a reader mistypes transcribing from
        an email — which is the entire trip this value has to survive."""
        assert confusable not in TRACKING_NUMBER_ALPHABET

    def test_the_alphabet_is_thirty_two_symbols(self) -> None:
        """Exactly 32 is what makes each character worth 5 whole bits, and the
        60-bit figure in the docstring checkable rather than approximate."""
        assert len(TRACKING_NUMBER_ALPHABET) == 32
        assert len(set(TRACKING_NUMBER_ALPHABET)) == 32


class TestUniqueness:
    """Not a guarantee — the UNIQUE constraint on the column is that (see
    `test_repository.py`). What these pin is that the generator is not
    accidentally deterministic, which is the failure mode that would make every
    creation after the first collide."""

    def test_two_calls_differ(self) -> None:
        assert new_tracking_number() != new_tracking_number()

    def test_ten_thousand_draws_are_all_distinct(self) -> None:
        """At 60 bits the birthday bound puts a collision in 10 000 draws at
        roughly 4e-11. A failure here means the entropy is not what it claims,
        not bad luck."""
        assert len({new_tracking_number() for _ in range(10_000)}) == 10_000


class TestItUsesACsprng:
    """The property no output can demonstrate — see the module docstring."""

    def test_it_draws_from_secrets_not_random(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`secrets.choice` is replaced and the generator's output is checked to
        have gone through it. A generator built on `random.choice`, or on
        `secrets.randbelow` with a hand-rolled modulo mapping, would not.
        """
        calls: list[str] = []

        def spy(alphabet: str) -> str:
            calls.append(alphabet)
            return "Z"

        monkeypatch.setattr(module.secrets, "choice", spy)
        number = new_tracking_number()

        assert number == "3MRAI-ZZZZ-ZZZZ-ZZZZ"
        assert calls == [TRACKING_NUMBER_ALPHABET] * (GROUP_COUNT * GROUP_SIZE)

    def test_the_module_does_not_import_random(self) -> None:
        """The blunt version of the rule: `random` has no business in this
        module at all, so it must not be reachable through it."""
        assert not hasattr(module, "random")
