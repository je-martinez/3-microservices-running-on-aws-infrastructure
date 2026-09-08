package http

import "strings"

// MaxBatchOrderIDs caps the batch read. Counted in DISTINCT, NON-EMPTY ids —
// duplicates and blanks are a caller being sloppy, not a request to reject.
const MaxBatchOrderIDs = 100

// ParseOrderIDs splits the CSV query parameter: trims parts, drops empties, and
// de-duplicates preserving FIRST-SEEN order (the cache key builder sorts its own
// copy). `?order_ids=a,,b` and `?order_ids=a,b,a` both yield [a b].
//
// CONTRACT: The result is always NON-NIL. The caller separates "no ids" (200,
// empty list) from "no parameter" (422) by the parameter's PRESENCE, never by
// this slice being nil. See [[openapi-specs]]
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
