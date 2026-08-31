package domain

import "fmt"

// Status is one of the five delivery statuses.
//
// Underlying type string so it stores directly into VARCHAR(50) and serializes
// directly onto the REST surface — one representation across wire, storage and
// HTTP. Stored as a plain VARCHAR rather than a MySQL ENUM: the REST surface
// carries it as a string, and widening a native ENUM is a DDL change.
type Status string

const (
	StatusPlaced         Status = "PLACED"
	StatusProcessing     Status = "PROCESSING"
	StatusShipped        Status = "SHIPPED"
	StatusOutForDelivery Status = "OUT_FOR_DELIVERY"
	StatusDelivered      Status = "DELIVERED"
)

// statusOrder is the allowed progression, in order. Position in this slice IS
// the ordering every guard below compares against.
//
// NEVER order statuses by comparing the Status values directly. Status has
// underlying type string, so `<` compiles and silently yields ALPHABETICAL
// order, in which DELIVERED < PLACED — the terminal status sorting before the
// initial one. That comparison would type-check, run, and be wrong. The index
// lookup below is the only ordering in this package.
var statusOrder = [...]Status{
	StatusPlaced,
	StatusProcessing,
	StatusShipped,
	StatusOutForDelivery,
	StatusDelivered,
}

const (
	// InitialStatus is the status every tracking is created at.
	InitialStatus = StatusPlaced
	// TerminalStatus is terminal: nothing may follow it, and nothing may update
	// a tracking sitting on it.
	TerminalStatus = StatusDelivered
)

// RejectionReason is the machine-readable reason a transition was rejected.
//
// Three distinct values on purpose. A single `requested > current` comparison
// would satisfy all three guards at once and collapse them into one
// indistinguishable failure. Keeping them separate gives the `reason` field the
// logging convention requires on *_failed events, and lets each guard be tested
// independently.
type RejectionReason string

const (
	// ReasonAlreadyDelivered — guard 1: the current status is terminal.
	ReasonAlreadyDelivered RejectionReason = "already_delivered"
	// ReasonBackwardTransition — guard 2: the requested status is earlier.
	ReasonBackwardTransition RejectionReason = "backward_transition"
	// ReasonNotStrictlyForward — guard 3: the requested status equals the current.
	ReasonNotStrictlyForward RejectionReason = "not_strictly_forward"
)

// TransitionCheck is the result of evaluating a transition. Reason is "" when
// Allowed is true.
type TransitionCheck struct {
	Allowed bool
	Reason  RejectionReason
}

// InvalidTransitionError is returned by AssertCanTransition. It carries the
// machine-readable Reason so the HTTP layer can log it without re-deriving why
// the transition failed.
type InvalidTransitionError struct {
	Current   Status
	Requested Status
	Reason    RejectionReason
}

func (e *InvalidTransitionError) Error() string {
	return fmt.Sprintf("cannot transition from %s to %s: %s", e.Current, e.Requested, e.Reason)
}

// StatusIndex returns s's position in the forward-only progression. ok is false
// for a value outside the five.
func StatusIndex(s Status) (int, bool) {
	for i, candidate := range statusOrder {
		if candidate == s {
			return i, true
		}
	}
	return 0, false
}

// CheckTransition evaluates current -> requested against the three guards.
//
// The guards run in this order and THE ORDER IS LOAD-BEARING. DELIVERED->PLACED
// violates guards 1 and 2 simultaneously; DELIVERED->DELIVERED violates 1 and 3.
// Terminality is the more specific fact about the tracking, so it is reported
// first.
//
// Skipping is ALLOWED: PLACED -> DELIVERED is legal. This is a forward-only
// machine, not a next-step-only one.
func CheckTransition(current, requested Status) TransitionCheck {
	// Guard 1: terminal. Checked before the ordering guards so that a tracking
	// already delivered reports already_delivered whatever is requested of it,
	// INCLUDING DELIVERED itself.
	if current == TerminalStatus {
		return TransitionCheck{Allowed: false, Reason: ReasonAlreadyDelivered}
	}

	currentIndex, ok := StatusIndex(current)
	if !ok {
		return TransitionCheck{Allowed: false, Reason: ReasonBackwardTransition}
	}
	requestedIndex, ok := StatusIndex(requested)
	if !ok {
		return TransitionCheck{Allowed: false, Reason: ReasonBackwardTransition}
	}

	// Guard 2: backward.
	if requestedIndex < currentIndex {
		return TransitionCheck{Allowed: false, Reason: ReasonBackwardTransition}
	}

	// Guard 3: strictly forward — equal is not forward. Distinct from guard 2:
	// guard 2 fires on `<`, this one only on `==`, so the two can never both be
	// the reported reason for the same pair.
	if requestedIndex == currentIndex {
		return TransitionCheck{Allowed: false, Reason: ReasonNotStrictlyForward}
	}

	return TransitionCheck{Allowed: true}
}

// CanTransition is the boolean view of CheckTransition.
func CanTransition(current, requested Status) bool {
	return CheckTransition(current, requested).Allowed
}

// AssertCanTransition returns an *InvalidTransitionError unless the transition
// is allowed. The form callers use when a rejection is exceptional — the PUT
// handler maps the returned error to 400 Bad Request.
func AssertCanTransition(current, requested Status) error {
	result := CheckTransition(current, requested)
	if result.Allowed {
		return nil
	}
	return &InvalidTransitionError{
		Current:   current,
		Requested: requested,
		Reason:    result.Reason,
	}
}

// NextStatus returns the single status following current.
//
// ok is false at the terminal status. Deliberately not an error: reaching the
// end of the progression is the expected way a TestMode run finishes.
func NextStatus(current Status) (Status, bool) {
	if current == TerminalStatus {
		return "", false
	}
	index, ok := StatusIndex(current)
	if !ok {
		return "", false
	}
	return statusOrder[index+1], true
}

// ParseStatus parses an external string into a Status.
//
// Case-SENSITIVE on purpose: the five values are a fixed wire contract shared
// with the proto, not free-form input. The REST handler turns the returned error
// into a 400.
func ParseStatus(s string) (Status, error) {
	for _, candidate := range statusOrder {
		if string(candidate) == s {
			return candidate, nil
		}
	}
	return "", fmt.Errorf(
		"invalid tracking status '%s'; expected one of: %s, %s, %s, %s, %s",
		s,
		StatusPlaced, StatusProcessing, StatusShipped, StatusOutForDelivery, StatusDelivered,
	)
}
