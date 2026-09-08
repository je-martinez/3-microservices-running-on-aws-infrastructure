package domain_test

import (
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// The display rule is MIRRORED from Orders
// (services/orders/src/Orders.Domain/OrderNumber.cs). These expectations are the
// same literals that side pins, so a drift makes the two services print two
// different numbers for one order — the failure the customer notices, because the
// confirmation email and the shipping email disagree.
func TestFormatOrderNumber(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		canonical string
		want      string
	}{
		{
			name:      "canonical value gains one hyphen after the date",
			canonical: "2609078KJ4M2",
			want:      "260907-8KJ4M2",
		},
		{
			// "" means the order has no number; callers treat that as "fall back to
			// the order id", so it must survive unchanged rather than become "-".
			name:      "empty stays empty",
			canonical: "",
			want:      "",
		},
		{
			// A row of unexpected width degrades to something readable instead of
			// panicking mid-render on a slice out of range.
			name:      "short value is returned untouched",
			canonical: "26090",
			want:      "26090",
		},
		{
			name:      "long value is returned untouched",
			canonical: "2609078KJ4M2XXXX",
			want:      "2609078KJ4M2XXXX",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if got := domain.FormatOrderNumber(tt.canonical); got != tt.want {
				t.Errorf("FormatOrderNumber(%q) = %q, want %q", tt.canonical, got, tt.want)
			}
		})
	}
}

// CONTRACT: Formatting is IDEMPOTENT-SAFE in the sense that matters here — an
// already-formatted value is 13 characters, so it falls through untouched rather
// than acquiring a second hyphen. A double-formatted number ("260907--8KJ4M2")
// would be unreadable and would not match anything support searched for.
func TestFormatOrderNumberDoesNotDoubleFormat(t *testing.T) {
	t.Parallel()

	once := domain.FormatOrderNumber("2609078KJ4M2")

	if twice := domain.FormatOrderNumber(once); twice != once {
		t.Errorf("formatting twice changed the value: %q then %q", once, twice)
	}
}
