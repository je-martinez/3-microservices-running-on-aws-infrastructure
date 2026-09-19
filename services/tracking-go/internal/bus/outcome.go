package bus

import "errors"

// ReasonUnhandledError is the `reason` for a failure nothing classified.
//
// CONTRACT: This token is a FALLBACK and must never overwrite a reason a handler
// already supplied. The generic pipeline catch that stamped it over a specific
// reason is a documented bug from this refactor's Node predecessor, and it
// survived 709 green tests because every test called the handler directly rather
// than through the bus. See [[logging-context]]
const ReasonUnhandledError = "unhandled_error"

// RoutineFailure is a non-happy-path outcome that is NOT a fault: a tracking
// that does not exist, a transition the state machine refuses. A route turns it
// into a 404 or a 400.
//
// CONTRACT: A routine failure logs `*_failed` with its `reason` and leaves the
// SPAN STATUS UNSET. Marking it ERROR trains whoever reads the waterfall to
// ignore errors on this service's spans, which is the habit that lets a real
// fault go unnoticed. See [[ADR-0019-distributed-tracing-opentelemetry]]
type RoutineFailure interface {
	error
	// FailureReason is the machine-readable token the log line and the span
	// attribute both carry, so trace and logs tell one story.
	FailureReason() string
}

// routineFailure marks cause as routine without hiding it.
type routineFailure struct {
	cause  error
	reason string
}

// Routine marks err as a routine failure carrying reason.
//
// CONTRACT: Wrap at the seam that KNOWS the outcome is routine — the use case or
// the wiring that maps its sentinel — never inside a behavior. A behavior
// deciding on its own which errors are routine has to keep a list of sentinels,
// and a sentinel missing from that list is silently promoted to a span ERROR.
func Routine(err error, reason string) RoutineFailure {
	return &routineFailure{cause: err, reason: reason}
}

// Error returns the cause's own text, so a route rendering err.Error() into a
// response body is unaffected by the marking.
func (e *routineFailure) Error() string { return e.cause.Error() }

// Unwrap exposes the cause, so errors.Is against the domain sentinel still
// decides the status code.
func (e *routineFailure) Unwrap() error { return e.cause }

func (e *routineFailure) FailureReason() string { return e.reason }

// Outcome is what the behaviors read to decide the `app_event` suffix, whether a
// `reason` is emitted at all, and whether the span is marked ERROR.
type Outcome struct {
	// Failed selects the `*_failed` suffix over `*_succeeded`.
	Failed bool
	// Thrown is the span-status dimension, and it is DELIBERATELY separate from
	// Failed. A behavior inspecting only `err != nil` collapses the two and marks
	// every 404 as a failed span.
	Thrown bool
	// Reason is empty on success — OMITTED, never null. See [[logging-context]]
	Reason string
}

// Classify decides an outcome from a handler's error.
//
// CONTRACT: Recognise a routine failure through a WRAP (errors.As, not a type
// assertion). A use case adding context with %w would otherwise turn its own 404
// into a span-ERROR fault, and the response would still be a 404 — so nothing
// visible to a caller reveals it.
func Classify(err error) Outcome {
	if err == nil {
		return Outcome{}
	}

	var routine RoutineFailure
	if errors.As(err, &routine) {
		return Outcome{Failed: true, Thrown: false, Reason: reasonOr(routine.FailureReason())}
	}

	return Outcome{Failed: true, Thrown: true, Reason: ReasonUnhandledError}
}

// reasonOr substitutes the fallback token for an empty reason, so a mismarked
// failure reaches the log as `unhandled_error` rather than `""` — an empty value
// is dropped by the log context's omitted-never-null rule and the line would
// carry no reason at all.
func reasonOr(reason string) string {
	if reason == "" {
		return ReasonUnhandledError
	}
	return reason
}
