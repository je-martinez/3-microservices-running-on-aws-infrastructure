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

// The workflow spans name WHICH business operation ran; otelgin's server span
// says only that a request arrived at a route.
//
// CONTRACT: These tests assert the span was EXPORTED, never that a field is
// non-nil — a tracer can be non-nil and still be a no-op provider. The guarded
// bug is a nil tracer ARGUMENT reaching handlers that each check `if h.tracer
// != nil`, which no reachability gate sees because the constructor IS called.
// See [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]]

// spanRecorder installs an in-memory exporter as the GLOBAL provider, because
// that is what tracing.Tracer() reads — the same call the composition root
// makes. Restoring the previous provider on cleanup keeps this from leaking
// into other tests in the package.
func spanRecorder(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()

	recorder := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))

	// CONTRACT: Set BOTH providers. otelgin resolves the GLOBAL one while
	// tracing.Tracer() reads a package-level variable initialised once from it,
	// so setting only the global gives a test where server spans arrive and
	// workflow spans do not — indistinguishable from the nil-tracer bug.
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
// expected to FAIL — the pool never connects — and the span is opened before the
// work and ended by defer, so the failure path proves the wiring without a
// database. init_tracking's span opens after auth and body validation, so its
// request must carry x-user-id and a well-formed body.
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
			// CONTRACT: Install the recorder BEFORE the router is built.
			// tracing.Tracer() resolves the global provider at call time and
			// NewAppRouter calls it while wiring, so the other order leaves the
			// handlers holding tracers that export nowhere.
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
