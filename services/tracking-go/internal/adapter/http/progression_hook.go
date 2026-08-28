package http

import (
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
)

// ProgressionStarter is the one method this adapter needs from the progression.
//
// Narrow, and declared HERE by its consumer rather than exported as an interface
// from app: the HTTP layer only ever schedules a run. Run and Wait belong to the
// composition root and to the tests, and widening this seam would let a handler
// reach them.
//
// It takes NO context, and that absence is load-bearing — see app.Progression's
// Start. A handler has only the REQUEST's context, which net/http cancels the
// instant the response is written; a signature that accepted one would invite
// exactly the bug this whole file exists to make unrepresentable.
type ProgressionStarter interface {
	Start(orderID string)
}

// TestModeProgressionHook adapts the progression to the init-tracking handler's
// ProgressionHook seam.
//
// It is a named type rather than a bare assignment so the wiring in main.go
// reads as "TestMode is live here", the same way NoopProgression reads as
// "deliberately does nothing".
type TestModeProgressionHook struct {
	progression ProgressionStarter
}

// NewTestModeProgressionHook wraps the progression. A nil progression yields a
// hook that still satisfies the seam and simply does nothing, so a degraded
// wiring cannot nil-panic on the first TestMode request.
//
// The parameter is the CONCRETE *app.Progression rather than the interface,
// deliberately: a typed nil stored in an interface is not equal to nil, so an
// interface parameter would make the guard below silently useless and the first
// TestMode request would dereference it inside a goroutine.
func NewTestModeProgressionHook(progression *app.Progression) ProgressionHook {
	if progression == nil {
		return NoopProgression{}
	}
	return NewProgressionHook(progression)
}

// NewProgressionHook wraps any starter. Separate from the constructor above so a
// test can drive the forwarding without constructing a whole app.Progression.
func NewProgressionHook(progression ProgressionStarter) TestModeProgressionHook {
	return TestModeProgressionHook{progression: progression}
}

// Start schedules a TestMode run for orderID and returns immediately.
//
// The handler calls this only AFTER the response has been written, and therefore
// after the creating transaction has committed. Starting it earlier races the
// commit: the progression's own fresh read would see no tracking and the run
// would end immediately at PLACED.
func (h TestModeProgressionHook) Start(orderID string) {
	h.progression.Start(orderID)
}
