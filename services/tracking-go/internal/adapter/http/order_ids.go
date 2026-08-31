package http

import "strings"

// MaxBatchOrderIDs caps the batch read. Counted in DISTINCT, NON-EMPTY ids —
// duplicates and blanks are a caller being sloppy, not a request to reject.
const MaxBatchOrderIDs = 100

// ParseOrderIDs splits the CSV query parameter.
//
// Trims each part, drops empties, de-duplicates preserving first-seen order.
// `?order_ids=a,,b` -> [a b]; `?order_ids=a,b,a` -> [a b]. The endpoint's whole
// contract is "return the ones you own among these", which is well defined for
// either, so neither case is an error worth failing on.
//
// FIRST-SEEN order, not sorted: the caller's ordering is the one thing this
// function must not editorialise, and the cache key builder sorts its own copy
// anyway.
//
// The result is always NON-NIL, including for input that yields nothing. It is
// handed to the cache key builder and to the use case, and the caller
// distinguishes "no ids" (200 with an empty list) from "no parameter at all"
// (422) by the parameter's PRESENCE, never by this slice being nil.
func ParseOrderIDs(raw string) []string {
	parts := strings.Split(raw, ",")
	seen := make(map[string]struct{}, len(parts))
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		cleaned := strings.TrimSpace(part)
		if cleaned == "" {
			continue
		}
		if _, dup := seen[cleaned]; dup {
			continue
		}
		seen[cleaned] = struct{}{}
		out = append(out, cleaned)
	}
	return out
}
