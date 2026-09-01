package http_test

import (
	"bytes"
	"context"
	nethttp "net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
)

// The workflow spans exist because a trace needs to say WHICH business operation
// ran. otelgin's server span says only that a request arrived at a route; it is
// the workflow span that names init_tracking or carrier_status_update.
//
// This file exists because all four of them were missing in production while
// every unit test stayed green. wire_app.go passed nil as the tracer, each
// handler guards with `if h.tracer != nil`, and the handlers' own tests inject a
// real tracer — so the only place the bug was observable was a running system.
// An E2E spec found it:
//
//	Trace 7ca38f79... has tracking spans but no 'init_tracking' workflow span
//
// The reachability gate could not see it either: it asks whether a seam is
// CALLED, and NewInitTrackingHandler was called. What arrived empty was an
// ARGUMENT. That is the shape this file guards.
//
// So these tests assert the span was EXPORTED, never that a field is non-nil. A
// tracer can be non-nil and still be a no-op provider; only the span proves it.

// spanRecorder installs an in-memory exporter as the GLOBAL provider, because
// that is what tracing.Tracer() reads — the same call the composition root
// makes. Restoring the previous provider on cleanup keeps this from leaking
// into other tests in the package.
func spanRecorder(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()

	recorder := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))

	// BOTH providers, and the pair is the whole point. otelgin resolves the
	// GLOBAL provider, while tracing.Tracer() reads a package-level variable in
	// internal/adapter/otel that was initialised once from the global and does
	// not track later changes to it. Setting only the global gives a test where
	// the server spans arrive and the workflow spans do not — which is
	// indistinguishable from the nil-tracer bug this file exists to catch, and
	// is exactly the false negative it produced when first written.
	previousGlobal := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	tracing.SetTracerProvider(tp)
	t.Cleanup(func() {
		otel.SetTracerProvider(previousGlobal)
		tracing.SetTracerProvider(previousGlobal)
	})

	return recorder
}

func spanNames(recorder *tracetest.SpanRecorder) []string {
	ended := recorder.Ended()
	names := make([]string, 0, len(ended))
	for _, s := range ended {
		names = append(names, s.Name())
	}
	return names
}

func hasSpan(recorder *tracetest.SpanRecorder, want string) bool {
	for _, name := range spanNames(recorder) {
		if name == want {
			return true
		}
	}
	return false
}

// Each case drives the route far enough to open its span. The requests are
// expected to FAIL — the pool never connects — and that is deliberate: the span
// is opened before the work and ended by defer, so the failure path proves the
// tracer is wired without needing a database. A span on the error path is still
// a span.
//
// Ordering matters for the request shape: init_tracking's span opens AFTER auth
// (401) and body validation (422), so its request must carry x-user-id and a
// well-formed body or it returns before the span is ever created.
func TestEveryWorkflowSpanIsEmittedThroughTheProductionRouter(t *testing.T) {
	cases := []struct {
		span    string
		method  string
		path    string
		body    string
		headers map[string]string
	}{
		{
			span:   "init_tracking",
			method: nethttp.MethodPost,
			path:   "/v1/trackings/init-tracking",
			body:   `{"order_id":"ord_wire_tracer_probe"}`,
			headers: map[string]string{
				"x-user-id":    "sub-wire-tracer",
				"content-type": "application/json",
			},
		},
		{
			span:   "carrier_status_update",
			method: nethttp.MethodPut,
			path:   "/v1/trackings/ord_wire_tracer_probe/status",
			body:   `{"status":"SHIPPED"}`,
			headers: map[string]string{
				"x-api-key":    "carrier-key",
				"content-type": "application/json",
			},
		},
		{
			span:   "internal_delete_by_user",
			method: nethttp.MethodDelete,
			path:   "/v1/trackings/by-user",
			body:   `{"cognito_sub":"sub-wire-tracer","user_id":"usr_wire_tracer"}`,
			headers: map[string]string{
				"x-api-key":    "internal-key",
				"content-type": "application/json",
			},
		},
		{
			span:   "e2e_cleanup",
			method: nethttp.MethodDelete,
			path:   "/v1/trackings/e2e-cleanup",
		},
	}

	for _, tc := range cases {
		t.Run(tc.span, func(t *testing.T) {
			// The recorder is installed BEFORE the router is built, and the order
			// is load-bearing rather than tidy: tracing.Tracer() resolves against
			// whatever provider is global AT THE MOMENT IT IS CALLED, and
			// NewAppRouter calls it while wiring. Install the recorder second and
			// the handlers hold tracers from the previous provider, which exports
			// nowhere — a failure indistinguishable from the nil-tracer bug this
			// file exists to catch.
			recorder := spanRecorder(t)

			// e2eEnabled: true so the cleanup route is mounted at all. The other
			// three are unaffected by the flag.
			router := adapterhttp.NewAppRouter(wireOptions(t, true))

			var body *bytes.Reader
			if tc.body != "" {
				body = bytes.NewReader([]byte(tc.body))
			} else {
				body = bytes.NewReader(nil)
			}

			req := httptest.NewRequestWithContext(context.Background(), tc.method, tc.path, body)
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}

			router.ServeHTTP(httptest.NewRecorder(), req)

			if !hasSpan(recorder, tc.span) {
				t.Fatalf(
					"no %q span was exported after %s %s — the composition root passed a nil tracer, "+
						"so the handler's span block is skipped and a trace cannot say which operation ran. "+
						"spans seen: %v",
					tc.span, tc.method, tc.path, spanNames(recorder),
				)
			}
		})
	}
}
