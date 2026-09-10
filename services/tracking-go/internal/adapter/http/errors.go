package http

// Three error body shapes coexist on this service's surface, plus FastAPI's
// validation shape, and they are NOT unified. Each is observable by a shipped
// client, and collapsing them would be a silent breaking change for whichever
// caller reads the field that moved.

// FlatError — Shape A: {"detail": "..."}.
//
// Every 401, the single read's 404, the carrier PUT's 404, the batch read's 400.
type FlatError struct {
	Detail string `json:"detail"`
}

// NestedErrorBody is the inner object of Shape B.
type NestedErrorBody struct {
	Detail string `json:"detail"`
	Reason string `json:"reason"`
}

// NestedError — Shape B: {"detail": {"detail": "...", "reason": "..."}}. Used
// ONLY by the 404 and 409 on POST /init-tracking.
//
// CONTRACT: The generated openapi.yaml declares these FLAT and is wrong — it
// describes the inner object as the whole body. Do NOT flatten the code to match
// it; shipped clients receive the nested shape, and the equivalence check
// records the difference in its allowlist. See [[openapi-specs]]
type NestedError struct {
	Detail NestedErrorBody `json:"detail"`
}

// ReasonError — Shape C: {"detail": "...", "reason": "..."}.
//
// ONLY the 400 on the carrier PUT, which Python routes through its own exception
// handler precisely so `reason` is a top-level field rather than Shape B.
type ReasonError struct {
	Detail string `json:"detail"`
	Reason string `json:"reason"`
}

// ValidationDetail is one entry of FastAPI's 422 body.
//
// The Go field is Typ because `type` is a keyword; the JSON tag is what the wire
// sees, and it says "type".
type ValidationDetail struct {
	Loc []string `json:"loc"`
	Msg string   `json:"msg"`
	Typ string   `json:"type"`
}

// ValidationError — Shape D: {"detail": [{"loc": [...], "msg": ..., "type": ...}]}.
//
// A LIST, even for a single problem: Pydantic reports every failed field at once,
// and a client that learned to iterate must keep working.
type ValidationError struct {
	Detail []ValidationDetail `json:"detail"`
}

// NewValidationError builds the single-entry form, which is what this service's
// hand-rolled validation produces.
func NewValidationError(loc []string, msg, typ string) ValidationError {
	return ValidationError{Detail: []ValidationDetail{{Loc: loc, Msg: msg, Typ: typ}}}
}
