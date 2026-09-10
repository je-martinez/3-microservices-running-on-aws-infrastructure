package http

import (
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// ProgressionStarter is the one method this adapter needs from the progression,
// declared here by its consumer so a handler cannot reach Run or Wait.
//
// CONTRACT: Do NOT give Start a context parameter. A handler holds only the
// REQUEST's context, which net/http cancels when the response is written, so the
// run dies at its first tick. See [[testmode-in-process-no-durable-scheduler]]
type ProgressionStarter interface {
	Start(tracking domain.TrackingWithHistory)
}

// TestModeProgressionHook adapts the progression to the init-tracking handler's
// ProgressionHook seam. A named type so main.go's wiring reads as "TestMode is
// live here", the way NoopProgression reads as "deliberately does nothing".
type TestModeProgressionHook struct {
	progression ProgressionStarter
}

// NewTestModeProgressionHook wraps the progression; a nil one yields a hook that
// does nothing, so degraded wiring cannot nil-panic on the first TestMode call.
//
// CONTRACT: The parameter is the CONCRETE *app.Progression, not the interface. A
// typed nil in an interface is not equal to nil, so an interface parameter makes
// the guard below useless and the first request dereferences it in a goroutine.
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

// Start schedules a TestMode run from the committed creation snapshot and
// returns immediately. The handler calls it only after the response is written,
// so the creating transaction has committed; the snapshot is what lets the run
// outlive a cleanup that tombstones the row before its first tick.
func (h TestModeProgressionHook) Start(tracking domain.TrackingWithHistory) {
	h.progression.Start(tracking)
}
