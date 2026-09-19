package bus_test

import (
	"context"
	"strings"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/bus"
)

// The composition order is the whole contract of Wrap, and it is the one thing a
// reader cannot infer from the call site: `Wrap(h, a, b)` reads left to right
// while the loop that builds it runs right to left.

func TestWrapAppliesTheFirstMiddlewareOutermost(t *testing.T) {
	var trace []string

	mw := func(name string) bus.Middleware[string, string] {
		return func(next bus.Handler[string, string]) bus.Handler[string, string] {
			return func(ctx context.Context, q string) (string, error) {
				trace = append(trace, name+"_enter")
				out, err := next(ctx, q)
				trace = append(trace, name+"_exit")
				return out, err
			}
		}
	}

	handler := func(_ context.Context, q string) (string, error) {
		trace = append(trace, "handler")
		return strings.ToUpper(q), nil
	}

	wrapped := bus.Wrap(handler, mw("outer"), mw("middle"), mw("inner"))

	got, err := wrapped(context.Background(), "ok")
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if got != "OK" {
		t.Errorf("result = %q, want %q", got, "OK")
	}

	want := []string{
		"outer_enter", "middle_enter", "inner_enter",
		"handler",
		"inner_exit", "middle_exit", "outer_exit",
	}
	if strings.Join(trace, ",") != strings.Join(want, ",") {
		t.Errorf("pipeline order:\n got %v\nwant %v", trace, want)
	}
}

func TestWrapWithNoMiddlewareReturnsTheHandler(t *testing.T) {
	calls := 0
	handler := func(_ context.Context, q int) (int, error) {
		calls++
		return q * 2, nil
	}

	got, err := bus.Wrap(handler)(context.Background(), 21)
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if got != 42 || calls != 1 {
		t.Errorf("result = %d (calls %d), want 42 (calls 1)", got, calls)
	}
}

// A middleware that never calls next must be able to stop the pipeline: that is
// how validation answers without touching the database.
func TestAMiddlewareCanShortCircuitTheHandler(t *testing.T) {
	reached := false
	handler := func(_ context.Context, _ string) (string, error) {
		reached = true
		return "handled", nil
	}

	block := func(bus.Handler[string, string]) bus.Handler[string, string] {
		return func(context.Context, string) (string, error) { return "blocked", nil }
	}

	got, err := bus.Wrap(handler, block)(context.Background(), "q")
	if err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if got != "blocked" {
		t.Errorf("result = %q, want %q", got, "blocked")
	}
	if reached {
		t.Error("the handler ran behind a short-circuiting middleware")
	}
}
