package domain

// The customer-facing order number's DISPLAY rule, mirrored from Orders.
//
// CONTRACT: Tracking MIRRORS this format, it does not own it — Orders
// (services/orders/src/Orders.Domain/OrderNumber.cs) does. Changing it here alone
// makes one order print two different numbers across its emails.
//
// CONTRACT: NO generator here. Orders owns uniqueness; a number minted on this
// side has no index behind it. See [[friendly-order-number]]

const (
	// orderNumberPrefixLength is the YYMMDD date half.
	orderNumberPrefixLength = 6

	// orderNumberTotalLength is the canonical (stored) width, no separator.
	orderNumberTotalLength = 12

	// orderNumberSeparator is inserted for DISPLAY only and never stored.
	orderNumberSeparator = "-"
)

// FormatOrderNumber renders the canonical form for a human: "2609078KJ4M2"
// becomes "260907-8KJ4M2".
//
// A value of unexpected width is returned untouched rather than sliced, so a
// malformed row degrades to something readable instead of panicking mid-render.
// "" stays "", which callers treat as "this order has no number".
func FormatOrderNumber(canonical string) string {
	if len(canonical) != orderNumberTotalLength {
		return canonical
	}

	return canonical[:orderNumberPrefixLength] +
		orderNumberSeparator +
		canonical[orderNumberPrefixLength:]
}
