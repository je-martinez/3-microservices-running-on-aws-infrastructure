package http_test

import (
	"testing"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
)

// hookRecordingStarter records the order ids handed to it.
type hookRecordingStarter struct{ started []string }

func (s *hookRecordingStarter) Start(orderID string) { s.started = append(s.started, orderID) }

// The adapter is a one-method forwarder, so what there is to get wrong is the
// id: a swapped or truncated one would schedule a run against a tracking that
// does not exist, and that run would end silently at PLACED — the same symptom
// as the accepted restart limitation.
func TestTestModeProgressionHookForwardsTheOrderIDUnchanged(t *testing.T) {
	starter := &hookRecordingStarter{}
	hook := adapterhttp.NewProgressionHook(starter)

	hook.Start("ord_forwarded")

	if len(starter.started) != 1 || starter.started[0] != "ord_forwarded" {
		t.Fatalf("started = %v, want [ord_forwarded]", starter.started)
	}
}

// A nil progression must degrade to the no-op rather than nil-panicking inside a
// handler on the first TestMode request.
func TestNewTestModeProgressionHookNilProgressionIsTheNoop(t *testing.T) {
	hook := adapterhttp.NewTestModeProgressionHook(nil)

	if _, ok := hook.(adapterhttp.NoopProgression); !ok {
		t.Fatalf("hook = %T, want NoopProgression for a nil progression", hook)
	}
	hook.Start("ord_1") // must not panic
}

// The hook must satisfy the handler's seam: this is what a wiring change would
// break first, and a compile-time assertion catches it at the commit rather than
// at the gateway.
func TestTestModeProgressionHookSatisfiesTheSeam(t *testing.T) {
	var _ adapterhttp.ProgressionHook = adapterhttp.NewProgressionHook(&hookRecordingStarter{})
}
