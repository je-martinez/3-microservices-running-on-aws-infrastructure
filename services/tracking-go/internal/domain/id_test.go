package domain

import (
	"strings"
	"testing"
)

func TestNanoIDAlphabetIsTheCrossServiceContract(t *testing.T) {
	// EXACT string, EXACT order. Users (TypeScript) and Orders (C#) declare the
	// same one. Changing this means changing all three services together.
	const want = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	if NanoIDAlphabet != want {
		t.Fatalf("NanoIDAlphabet =\n  %q\nwant\n  %q", NanoIDAlphabet, want)
	}
	if len(NanoIDAlphabet) != 62 {
		t.Fatalf("NanoIDAlphabet has %d symbols, want 62", len(NanoIDAlphabet))
	}
	// nanoid's default alphabet adds these two. Ours must not.
	if strings.ContainsAny(NanoIDAlphabet, "_-") {
		t.Error("NanoIDAlphabet contains '_' or '-'; both are excluded on purpose")
	}
}

func TestIDLengthIsDerivedNotRestated(t *testing.T) {
	if PrefixLength+NanoIDLength != IDLength {
		t.Fatalf("PrefixLength(%d) + NanoIDLength(%d) = %d, but IDLength = %d",
			PrefixLength, NanoIDLength, PrefixLength+NanoIDLength, IDLength)
	}
	if len(TrackingPrefix) != PrefixLength {
		t.Errorf("len(TrackingPrefix) = %d, want %d", len(TrackingPrefix), PrefixLength)
	}
	if len(RequestPrefix) != PrefixLength {
		t.Errorf("len(RequestPrefix) = %d, want %d", len(RequestPrefix), PrefixLength)
	}
}

func TestNewTrackingIDFormat(t *testing.T) {
	id, err := NewTrackingID()
	if err != nil {
		t.Fatalf("NewTrackingID() error = %v", err)
	}
	if len(id) != IDLength {
		t.Errorf("len(%q) = %d, want %d", id, len(id), IDLength)
	}
	if !strings.HasPrefix(id, TrackingPrefix) {
		t.Errorf("%q does not start with %q", id, TrackingPrefix)
	}
	random := strings.TrimPrefix(id, TrackingPrefix)
	if len(random) != NanoIDLength {
		t.Errorf("random portion of %q is %d chars, want %d", id, len(random), NanoIDLength)
	}
	for _, r := range random {
		if !strings.ContainsRune(NanoIDAlphabet, r) {
			t.Errorf("%q contains %q, which is outside the alphabet", id, r)
		}
	}
}

func TestNewRequestIDFormat(t *testing.T) {
	id, err := NewRequestID()
	if err != nil {
		t.Fatalf("NewRequestID() error = %v", err)
	}
	if len(id) != IDLength {
		t.Errorf("len(%q) = %d, want %d", id, len(id), IDLength)
	}
	if !strings.HasPrefix(id, RequestPrefix) {
		t.Errorf("%q does not start with %q", id, RequestPrefix)
	}
}

func TestNewTrackingNumberFormat(t *testing.T) {
	number, err := NewTrackingNumber()
	if err != nil {
		t.Fatalf("NewTrackingNumber() error = %v", err)
	}
	if len(number) != TrackingNumberLength {
		t.Errorf("len(%q) = %d, want %d", number, len(number), TrackingNumberLength)
	}
	parts := strings.Split(number, TrackingNumberSeparator)
	if len(parts) != TrackingNumberGroupCount+1 {
		t.Fatalf("%q split into %d parts, want %d (prefix + %d groups)",
			number, len(parts), TrackingNumberGroupCount+1, TrackingNumberGroupCount)
	}
	if parts[0] != TrackingNumberPrefix {
		t.Errorf("prefix of %q = %q, want %q", number, parts[0], TrackingNumberPrefix)
	}
	for i, group := range parts[1:] {
		if len(group) != TrackingNumberGroupSize {
			t.Errorf("group %d of %q is %d chars, want %d", i, number, len(group), TrackingNumberGroupSize)
		}
		for _, r := range group {
			if !strings.ContainsRune(TrackingNumberAlphabet, r) {
				t.Errorf("%q contains %q, which is outside the alphabet", number, r)
			}
		}
	}
}

func TestTrackingNumberAlphabetExcludesConfusableCharacters(t *testing.T) {
	const want = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	if TrackingNumberAlphabet != want {
		t.Fatalf("TrackingNumberAlphabet =\n  %q\nwant\n  %q", TrackingNumberAlphabet, want)
	}
	if len(TrackingNumberAlphabet) != 32 {
		t.Fatalf("TrackingNumberAlphabet has %d symbols, want 32", len(TrackingNumberAlphabet))
	}
	// I/O/0/1 are the pairs a reader confuses transcribing from an email.
	for _, excluded := range []rune{'I', 'O', '0', '1'} {
		if strings.ContainsRune(TrackingNumberAlphabet, excluded) {
			t.Errorf("alphabet contains %q; I, O, 0 and 1 are excluded as confusable", excluded)
		}
	}
}

func TestTrackingNumberLengthIsDerived(t *testing.T) {
	want := len(TrackingNumberPrefix) +
		TrackingNumberGroupCount*(len(TrackingNumberSeparator)+TrackingNumberGroupSize)
	if TrackingNumberLength != want {
		t.Fatalf("TrackingNumberLength = %d, want %d", TrackingNumberLength, want)
	}
	if TrackingNumberLength != 20 {
		t.Fatalf("TrackingNumberLength = %d, want 20", TrackingNumberLength)
	}
}

// Not a proof of uniqueness — that is the UNIQUE constraint's job. This catches
// the generator being broken outright: a constant return, a stuck RNG, or an
// alphabet index that never varies.
func TestGeneratorsDoNotRepeat(t *testing.T) {
	const n = 5000

	ids := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		id, err := NewTrackingID()
		if err != nil {
			t.Fatalf("NewTrackingID() error at iteration %d = %v", i, err)
		}
		if _, dup := ids[id]; dup {
			t.Fatalf("NewTrackingID() returned duplicate %q within %d generations", id, n)
		}
		ids[id] = struct{}{}
	}

	numbers := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		number, err := NewTrackingNumber()
		if err != nil {
			t.Fatalf("NewTrackingNumber() error at iteration %d = %v", i, err)
		}
		if _, dup := numbers[number]; dup {
			t.Fatalf("NewTrackingNumber() returned duplicate %q within %d generations", number, n)
		}
		numbers[number] = struct{}{}
	}
}

// A crude bias check. With rejection sampling every symbol should appear a
// roughly equal number of times. Modulo bias over 62 symbols would leave the
// first 8 symbols noticeably over-represented; the loose bound below still
// catches that while never flaking on ordinary randomness.
func TestNanoIDCoversItsWholeAlphabet(t *testing.T) {
	const n = 4000
	seen := make(map[rune]int, len(NanoIDAlphabet))
	for i := 0; i < n; i++ {
		id, err := NewTrackingID()
		if err != nil {
			t.Fatalf("NewTrackingID() error = %v", err)
		}
		for _, r := range strings.TrimPrefix(id, TrackingPrefix) {
			seen[r]++
		}
	}
	if len(seen) != len(NanoIDAlphabet) {
		t.Fatalf("only %d of %d alphabet symbols were ever produced", len(seen), len(NanoIDAlphabet))
	}
	total := n * NanoIDLength
	expected := total / len(NanoIDAlphabet)
	for _, r := range NanoIDAlphabet {
		count := seen[r]
		if count < expected/2 || count > expected*2 {
			t.Errorf("symbol %q appeared %d times; expected roughly %d (modulo bias?)",
				r, count, expected)
		}
	}
}
