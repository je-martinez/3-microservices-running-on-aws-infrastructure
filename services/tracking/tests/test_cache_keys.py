"""The cache key builders.

No database and no Redis: these are pure functions, and the only reason they
have their own file is that the rules they encode (skip when `user_id` is
unresolved; normalize a list before hashing it) are the two ways a caching
layer silently serves the wrong body.
"""

from src.shared.cache.keys import CacheKeys

SUB_A = "11111111-1111-4111-8111-111111111111"
SUB_B = "22222222-2222-4222-8222-222222222222"
USER_A = "usr_aaaaaaaaaaaaaaaaaaaaa"
USER_B = "usr_bbbbbbbbbbbbbbbbbbbbb"


class TestSingleTrackingKey:
    def test_carries_both_identities_and_the_order_id(self) -> None:
        key = CacheKeys.tracking_order(SUB_A, USER_A, "ord_1")
        assert key == f"tracking:order:v1:{SUB_A}:{USER_A}:ord_1"

    def test_two_users_never_share_a_key(self) -> None:
        assert CacheKeys.tracking_order(SUB_A, USER_A, "ord_1") != (
            CacheKeys.tracking_order(SUB_B, USER_B, "ord_1")
        )

    def test_unresolved_user_id_means_NO_key(self) -> None:
        """`user_id` is legitimately None for an authenticated caller.

        `log_identity._resolve_quietly` swallows UnknownUserError, RpcError and
        anything else, so a perfectly valid caller can reach a handler with no
        internal id. Embedding "None" in the key would give every such caller a
        SHARED key — a cross-user leak dressed as a cache hit. The builder
        answers None and the route skips caching for that request.
        """
        assert CacheKeys.tracking_order(SUB_A, None, "ord_1") is None


class TestListKey:
    def test_normalizes_before_hashing(self) -> None:
        """Two orderings of the same set are ONE key, not two."""
        assert CacheKeys.tracking_list(SUB_A, USER_A, ["b", "a"]) == (
            CacheKeys.tracking_list(SUB_A, USER_A, ["a", "b"])
        )

    def test_deduplicates_before_hashing(self) -> None:
        assert CacheKeys.tracking_list(SUB_A, USER_A, ["a", "a", "b"]) == (
            CacheKeys.tracking_list(SUB_A, USER_A, ["a", "b"])
        )

    def test_different_sets_are_different_keys(self) -> None:
        assert CacheKeys.tracking_list(SUB_A, USER_A, ["a", "b"]) != (
            CacheKeys.tracking_list(SUB_A, USER_A, ["a", "c"])
        )

    def test_carries_the_prefix_and_both_identities(self) -> None:
        key = CacheKeys.tracking_list(SUB_A, USER_A, ["a"])
        assert key is not None
        assert key.startswith(f"tracking:list:v1:{SUB_A}:{USER_A}:")

    def test_hash_is_fixed_length_regardless_of_input_size(self) -> None:
        """The whole point of hashing: 100 ids must not make a 100-id key."""
        small = CacheKeys.tracking_list(SUB_A, USER_A, ["a"])
        large = CacheKeys.tracking_list(
            SUB_A, USER_A, [f"ord_{n}" for n in range(100)]
        )
        assert small is not None and large is not None
        assert len(small) == len(large)

    def test_separator_cannot_be_forged_by_an_order_id(self) -> None:
        """`["ab", "c"]` and `["a", "bc"]` must not collide.

        The newline join is what guarantees it: an order id cannot contain a
        newline, so no pair of distinct sets can produce the same joined string.
        """
        assert CacheKeys.tracking_list(SUB_A, USER_A, ["ab", "c"]) != (
            CacheKeys.tracking_list(SUB_A, USER_A, ["a", "bc"])
        )

    def test_unresolved_user_id_means_NO_key(self) -> None:
        assert CacheKeys.tracking_list(SUB_A, None, ["a"]) is None


class TestIdentityKey:
    def test_is_keyed_on_the_sub_alone(self) -> None:
        """It is the thing that RESOLVES user_id, so it cannot contain one."""
        assert CacheKeys.identity(SUB_A) == f"identity:sub-to-user:v1:{SUB_A}"


class TestUserIndexKey:
    def test_names_the_user_whose_keys_it_holds(self) -> None:
        assert CacheKeys.user_index(SUB_A, USER_A) == (
            f"tracking:index:v1:{SUB_A}:{USER_A}"
        )


class TestPrefixExtraction:
    def test_stops_at_the_version_segment(self) -> None:
        """Telemetry gets the prefix ONLY — never the sub or the user id."""
        key = f"tracking:order:v1:{SUB_A}:{USER_A}:ord_1"
        assert CacheKeys.prefix_of(key) == "tracking:order:v1"

    def test_prefix_of_an_identity_key(self) -> None:
        assert CacheKeys.prefix_of(CacheKeys.identity(SUB_A)) == (
            "identity:sub-to-user:v1"
        )

    def test_prefix_of_a_list_key_hides_the_hash(self) -> None:
        key = CacheKeys.tracking_list(SUB_A, USER_A, ["a"])
        assert key is not None
        assert CacheKeys.prefix_of(key) == "tracking:list:v1"
        assert SUB_A not in CacheKeys.prefix_of(key)
