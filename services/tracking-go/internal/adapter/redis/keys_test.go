package redis_test

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

func TestTrackingOrderKey(t *testing.T) {
	got, ok := cache.TrackingOrderKey("sub-abc", "usr_1", "ord_9")
	if !ok {
		t.Fatal("TrackingOrderKey returned no key for a fully identified request")
	}
	want := "tracking:order:v1:sub-abc:usr_1:ord_9"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestIdentityKey(t *testing.T) {
	if got, want := cache.IdentityKey("sub-abc"), "identity:sub-to-user:v1:sub-abc"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestUserIndexKey(t *testing.T) {
	if got, want := cache.UserIndexKey("sub-abc", "usr_1"), "tracking:index:v1:sub-abc:usr_1"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// An empty user_id means NO KEY: the route then skips caching entirely rather
// than writing a key whose scoping segment is a lie.
func TestBuildersAnswerNoKeyWithoutAUserID(t *testing.T) {
	if key, ok := cache.TrackingOrderKey("sub-abc", "", "ord_9"); ok {
		t.Errorf("TrackingOrderKey built %q with an empty user_id", key)
	}
	if key, ok := cache.TrackingListKey("sub-abc", "", []string{"ord_9"}); ok {
		t.Errorf("TrackingListKey built %q with an empty user_id", key)
	}
}

// Sorting and deduplicating BEFORE hashing collapses every ordering and every
// repetition of one set onto one key.
func TestTrackingListKeyNormalizesBeforeHashing(t *testing.T) {
	a, ok := cache.TrackingListKey("s", "usr_1", []string{"b", "a"})
	if !ok {
		t.Fatal("no key")
	}
	b, _ := cache.TrackingListKey("s", "usr_1", []string{"a", "b"})
	c, _ := cache.TrackingListKey("s", "usr_1", []string{"a", "b", "a"})

	if a != b || b != c {
		t.Errorf("orderings and repetitions produced different keys:\n%s\n%s\n%s", a, b, c)
	}
}

// The digest is sha256 of the newline-joined sorted unique ids, truncated to 16
// hex chars. Recomputed here so the test fails if the algorithm ever changes.
func TestTrackingListKeyDigestIsSHA256(t *testing.T) {
	ids := []string{"ord_b", "ord_a", "ord_b"}
	got, ok := cache.TrackingListKey("sub-abc", "usr_1", ids)
	if !ok {
		t.Fatal("no key")
	}

	sum := sha256.Sum256([]byte("ord_a\nord_b"))
	wantDigest := hex.EncodeToString(sum[:])[:16]
	want := "tracking:list:v1:sub-abc:usr_1:" + wantDigest
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

// A stable hash across processes. Python's per-process PYTHONHASHSEED salting
// would make two replicas compute different keys for the same request; in Go the
// equivalent trap is maphash. Two separate computations must agree.
func TestTrackingListKeyIsStableAcrossCalls(t *testing.T) {
	ids := []string{"ord_1", "ord_2", "ord_3"}
	first, _ := cache.TrackingListKey("s", "usr_1", ids)
	for i := 0; i < 50; i++ {
		again, _ := cache.TrackingListKey("s", "usr_1", ids)
		if again != first {
			t.Fatalf("key is not stable: %q then %q", first, again)
		}
	}
}

// The newline separator cannot appear inside an order id, so these cannot
// collide.
func TestTrackingListKeySeparatorPreventsCollision(t *testing.T) {
	a, _ := cache.TrackingListKey("s", "usr_1", []string{"ab", "c"})
	b, _ := cache.TrackingListKey("s", "usr_1", []string{"a", "bc"})
	if a == b {
		t.Errorf("['ab','c'] and ['a','bc'] produced the same key: %q", a)
	}
}

func TestTrackingListKeyWithNoIDs(t *testing.T) {
	got, ok := cache.TrackingListKey("s", "usr_1", nil)
	if !ok {
		t.Fatal("an empty id list is still keyable")
	}
	if !strings.HasPrefix(got, "tracking:list:v1:s:usr_1:") {
		t.Errorf("got %q", got)
	}
}

// PrefixOf keeps the first THREE segments and nothing more. A full key carries
// cognito_sub and user_id; a span, a dimension and a log field are all export
// destinations.
func TestPrefixOf(t *testing.T) {
	tests := []struct {
		key  string
		want string
	}{
		{"tracking:order:v1:sub-abc:usr_1:ord_9", "tracking:order:v1"},
		{"tracking:list:v1:sub-abc:usr_1:abcdef0123456789", "tracking:list:v1"},
		{"identity:sub-to-user:v1:sub-abc", "identity:sub-to-user:v1"},
		{"tracking:index:v1:sub-abc:usr_1", "tracking:index:v1"},
		{"short:key", "short:key"},
		{"", ""},
	}
	for _, tt := range tests {
		t.Run(tt.key, func(t *testing.T) {
			got := cache.PrefixOf(tt.key)
			if got != tt.want {
				t.Errorf("PrefixOf(%q) = %q, want %q", tt.key, got, tt.want)
			}
			if strings.Contains(got, "sub-abc") || strings.Contains(got, "usr_1") {
				t.Errorf("PrefixOf(%q) = %q leaked identity", tt.key, got)
			}
		})
	}
}
