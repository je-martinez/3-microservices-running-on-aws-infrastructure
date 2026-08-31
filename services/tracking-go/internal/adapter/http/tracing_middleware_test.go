package http_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	oteltrace "go.opentelemetry.io/otel/trace"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// The INBOUND half of trace correlation.
//
// Three of this service's tracing surfaces were already wired and tested — the
// workflow spans, the outbound otelgrpc client, the hand-instrumented SQS
// producer. The inbound one was not: otelgin was absent from go.mod entirely
// while tracing.GinFilter sat defined, documented and referenced by nothing.
//
// # WHY THESE TESTS COUNT DISTINCT TRACE IDS RATHER THAN ASSERTING "A SPAN EXISTS"
//
// Because the bug this file exists to catch PRODUCES SPANS. With no inbound
// extraction, the workflow spans still open, still export, and still look
// correct in isolation — they simply start as fresh ROOTS instead of hanging off
// the caller's trace. The result of a propagation failure is therefore TWO
// COMPLETE, DISCONNECTED TRACES rather than one visibly broken one, and every
// "is it traced?" assertion passes on both. Only counting distinct trace ids
// tells them apart.
//
// That is the same shape as the closing gate's cross-service check
// (gateway -> Go -> Users must be ONE trace id), moved down to a unit test so it
// fails at the commit that breaks it rather than in a wave-3 E2E.

// traceRecorder installs an in-memory exporter as the package tracer provider
// and returns the spans collected so far.
//
// It points BOTH the global provider (otelgin resolves through
// otel.GetTracerProvider) and the tracing package's own provider (WorkflowSpan
// reads that one) at the same recorder, so a single request's server span and
// workflow span land in one place and can be compared.
//
// IT ALSO INSTALLS THE W3C PROPAGATOR, and that is not test scaffolding for its
// own sake — it reproduces what SetupTracing does in the process. OTel's DEFAULT
// global propagator is a NO-OP whose Fields() is empty: it extracts nothing and
// injects nothing, silently. So a test that skipped this would see every inbound
// traceparent ignored and would blame the middleware.
//
// The same fact is a production constraint, pinned by
// TestOtelginSnapshotsTheGlobalsAtConstruction below: otelgin.Middleware()
// resolves the provider and the propagator ONCE, when it is constructed. Calling
// NewAppRouter before SetupTracing would therefore capture the no-op propagator
// for the life of the process, and no later SetTextMapPropagator would fix it.
func traceRecorder(t *testing.T) func() []sdktrace.ReadOnlySpan {
	t.Helper()

	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })

	previousProvider := otel.GetTracerProvider()
	previousPropagator := otel.GetTextMapPropagator()
	otel.SetTracerProvider(tp)
	tracing.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))
	t.Cleanup(func() {
		otel.SetTracerProvider(previousProvider)
		tracing.SetTracerProvider(previousProvider)
		otel.SetTextMapPropagator(previousPropagator)
	})

	// A CLOSURE over the exporter, not exporter.GetSpans().Snapshots — that
	// expression calls GetSpans() NOW and binds the method value of the snapshot
	// taken before any request has run, so every later read returns the empty
	// slice it captured. (The plan's own recorder helper has this shape; it works
	// there only because those tests never call the returned function.)
	return func() []sdktrace.ReadOnlySpan { return exporter.GetSpans().Snapshots() }
}

// distinctTraceIDs is the assertion these tests are built on.
func distinctTraceIDs(spans []sdktrace.ReadOnlySpan) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, span := range spans {
		id := span.SpanContext().TraceID().String()
		if _, ok := seen[id]; !ok {
			seen[id] = struct{}{}
			out = append(out, id)
		}
	}
	return out
}

// tracingRouter builds a router whose middleware chain is the REAL one, plus a
// probe route that opens a workflow span exactly as a use case would.
//
// The chain is taken from NewAppRouter rather than reassembled here: a test that
// built its own chain would keep passing after somebody removed the middleware
// from the composition root, which is precisely the defect being pinned.
func tracingRouter(t *testing.T, logs *bytes.Buffer) *gin.Engine {
	t.Helper()

	gin.SetMode(gin.TestMode)

	opts := wireOptions(t, false)
	// THE COMPLETE process logger stack, not a bare JSON handler: TraceHandler
	// outside ContextHandler outside the schema renderer, exactly as
	// cmd/server/logging_wiring.go builds it. A test logger missing either layer
	// would assert on a logger the process never uses — and the trace_id these
	// tests look for is written by the OUTER layer specifically.
	base := logging.New(logs, logging.ServiceName, "test")
	opts.Logger = slog.New(tracing.NewTraceHandler(base.Handler()))
	router := adapterhttp.NewAppRouter(opts)

	// A route that opens a workflow span, standing in for get_tracking and
	// friends. Registered on the same engine so it runs through the same chain.
	router.GET("/v1/probe", func(c *gin.Context) {
		ctx, end := tracing.WorkflowSpan(c.Request.Context(), "probe_workflow")
		end(nil)
		_ = ctx
		c.JSON(nethttp.StatusOK, gin.H{"status": "ok"})
	})

	return router
}

// ─── The gap this file closes ────────────────────────────────────────────────

// TestInboundTraceparentIsAdopted is THE test that would have caught the missing
// wiring.
//
// The gateway sends a traceparent. Every span this service produces for that
// request must carry the SAME trace id, or the request's work appears in
// OpenObserve as a second, unrelated trace.
func TestInboundTraceparentIsAdopted(t *testing.T) {
	spansOf := traceRecorder(t)
	router := tracingRouter(t, &bytes.Buffer{})

	const inboundTraceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/v1/probe", nil)
	req.Header.Set("traceparent", "00-"+inboundTraceID+"-00f067aa0ba902b7-01")

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)

	if recorder.Code != nethttp.StatusOK {
		t.Fatalf("probe status = %d, want 200", recorder.Code)
	}

	spans := spansOf()
	if len(spans) == 0 {
		t.Fatal("no spans were recorded: the inbound HTTP instrumentation is not wired")
	}

	for _, span := range spans {
		if got := span.SpanContext().TraceID().String(); got != inboundTraceID {
			t.Errorf("span %q has trace id %s, want the INBOUND %s — "+
				"the caller's traceparent was discarded and this span started a new trace",
				span.Name(), got, inboundTraceID)
		}
	}
}

// TestOneRequestProducesExactlyOneTraceID is the counting assertion.
//
// A server span AND a workflow span, in ONE trace. With otelgin absent the
// workflow span still exists and still exports — it is simply a root of its own,
// so this count comes back as 1 for the wrong reason. Hence the companion
// assertion that BOTH kinds of span were actually produced: counting alone is
// satisfiable by a service that traces nothing at all.
func TestOneRequestProducesExactlyOneTraceID(t *testing.T) {
	spansOf := traceRecorder(t)
	router := tracingRouter(t, &bytes.Buffer{})

	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/v1/probe", nil)
	req.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")

	router.ServeHTTP(httptest.NewRecorder(), req)

	spans := spansOf()

	// Both kinds must be present, or "one trace id" is trivially true.
	var sawServer, sawWorkflow bool
	for _, span := range spans {
		if span.SpanKind() == oteltrace.SpanKindServer {
			sawServer = true
		}
		if span.Name() == "probe_workflow" {
			sawWorkflow = true
		}
	}
	if !sawServer {
		t.Error("no SERVER span: otelgin is not in the middleware chain")
	}
	if !sawWorkflow {
		t.Error("no workflow span: the probe route did not open one")
	}

	if ids := distinctTraceIDs(spans); len(ids) != 1 {
		t.Fatalf("one request produced %d distinct trace ids (%v), want exactly 1. "+
			"More than one means the inbound context is not reaching the workflow span, "+
			"and the flow appears in OpenObserve as several unrelated traces",
			len(ids), ids)
	}
}

// TestServerSpanIsTheWorkflowSpansParent pins the RELATIONSHIP, not merely the
// shared id. Two spans can share a trace id and still both be roots.
func TestServerSpanIsTheWorkflowSpansParent(t *testing.T) {
	spansOf := traceRecorder(t)
	router := tracingRouter(t, &bytes.Buffer{})

	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/v1/probe", nil)
	router.ServeHTTP(httptest.NewRecorder(), req)

	var workflow, server sdktrace.ReadOnlySpan
	for _, span := range spansOf() {
		switch {
		case span.Name() == "probe_workflow":
			workflow = span
		case span.SpanKind() == oteltrace.SpanKindServer:
			server = span
		}
	}
	if workflow == nil || server == nil {
		t.Fatalf("missing spans: workflow=%v server=%v", workflow != nil, server != nil)
	}

	if workflow.Parent().SpanID() != server.SpanContext().SpanID() {
		t.Errorf("the workflow span's parent is %s, want the server span %s — "+
			"the handler is not reading the instrumented request context",
			workflow.Parent().SpanID(), server.SpanContext().SpanID())
	}
}

// TestRequestWithoutTraceparentStartsANewTrace: no inbound header is a NORMAL
// case (a direct internal call, a load test, a curl), never a failure.
func TestRequestWithoutTraceparentStartsANewTrace(t *testing.T) {
	spansOf := traceRecorder(t)
	router := tracingRouter(t, &bytes.Buffer{})

	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/v1/probe", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)

	if recorder.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200: an absent traceparent must not fail the request", recorder.Code)
	}

	spans := spansOf()
	if len(spans) == 0 {
		t.Fatal("no spans recorded for an un-parented request")
	}
	for _, span := range spans {
		if !span.SpanContext().TraceID().IsValid() {
			t.Errorf("span %q has an invalid trace id; a fresh trace should have been started", span.Name())
		}
	}
	if ids := distinctTraceIDs(spans); len(ids) != 1 {
		t.Errorf("an un-parented request produced %d trace ids (%v), want 1", len(ids), ids)
	}
}

// TestMalformedTraceparentStartsANewTrace: a garbage header must degrade to a
// new trace, never to a rejected request.
func TestMalformedTraceparentStartsANewTrace(t *testing.T) {
	spansOf := traceRecorder(t)
	router := tracingRouter(t, &bytes.Buffer{})

	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/v1/probe", nil)
	req.Header.Set("traceparent", "not-a-valid-traceparent")

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)

	if recorder.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200: a malformed traceparent must not fail the request", recorder.Code)
	}
	if spans := spansOf(); len(spans) == 0 {
		t.Error("a malformed traceparent produced no spans at all; it should start a fresh trace")
	}
}

// ─── The health exclusion ────────────────────────────────────────────────────

// TestHealthProducesNoServerSpan pins GinFilter's ONLY reason to exist.
//
// The ALB probes /v1/health continuously; unfiltered it would be the
// overwhelming majority of this service's spans. Python excludes it with
// OTEL_PYTHON_FASTAPI_EXCLUDED_URLS="/v1/health$"; Go has no such variable, so
// the filter must be PASSED to otelgin — defining it is not wiring it.
func TestHealthProducesNoServerSpan(t *testing.T) {
	spansOf := traceRecorder(t)
	router := tracingRouter(t, &bytes.Buffer{})

	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/v1/health", nil)
	// WITH a traceparent: the filter must win even when the caller asked for
	// tracing, or every probe from an instrumented prober is still traced.
	req.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)

	if recorder.Code != nethttp.StatusOK {
		t.Fatalf("health status = %d, want 200", recorder.Code)
	}
	if spans := spansOf(); len(spans) != 0 {
		names := make([]string, 0, len(spans))
		for _, span := range spans {
			names = append(names, span.Name())
		}
		t.Errorf("the liveness probe produced %d spans (%v), want 0 — "+
			"GinFilter is not being passed to otelgin", len(spans), names)
	}
}

// TestANonHealthRouteIsStillTraced guards the filter from over-reaching: a
// filter that rejected everything would pass the health test and silently
// disable inbound tracing entirely.
func TestANonHealthRouteIsStillTraced(t *testing.T) {
	spansOf := traceRecorder(t)
	router := tracingRouter(t, &bytes.Buffer{})

	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/v1/probe", nil)
	router.ServeHTTP(httptest.NewRecorder(), req)

	if len(spansOf()) == 0 {
		t.Error("a normal route produced no spans; the filter is rejecting more than /v1/health")
	}
}

// ─── The chain ORDER, observed through the request line ──────────────────────

// TestTheRequestLineCarriesTheTraceID is the ORDERING test.
//
// LogContextMiddleware emits `request completed` from a DEFERRED position, after
// c.Next() returns. otelgin sets the span onto c.Request before calling
// c.Next() and RESTORES the saved context in its own deferred function — so if
// otelgin is registered INSIDE LogContextMiddleware, the span is already gone
// from c.Request.Context() by the time the request line is written, and the line
// carries no trace_id at all. Which is the same silent failure as the original
// gap, relocated: a log line nothing can join to a trace.
//
// Registering otelgin OUTSIDE LogContextMiddleware is what makes this pass.
func TestTheRequestLineCarriesTheTraceID(t *testing.T) {
	traceRecorder(t)

	var logs bytes.Buffer
	router := tracingRouter(t, &logs)

	const inboundTraceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/v1/probe", nil)
	req.Header.Set("traceparent", "00-"+inboundTraceID+"-00f067aa0ba902b7-01")

	router.ServeHTTP(httptest.NewRecorder(), req)

	line := findLogLine(t, logs.Bytes(), "request completed")
	got, _ := line["trace_id"].(string)
	if got == "" {
		t.Fatalf("the `request completed` line carries no trace_id: %s\n"+
			"otelgin must be registered OUTSIDE LogContextMiddleware — it restores the "+
			"pre-span context in a deferred call, so a line written after c.Next() "+
			"from an inner middleware sees no span", logs.String())
	}
	if got != inboundTraceID {
		t.Errorf("request line trace_id = %s, want the inbound %s", got, inboundTraceID)
	}
}

// TestTheRequestLineStillCarriesItsCorrelationFields guards against fixing the
// ordering by moving LogContextMiddleware somewhere that breaks ITS contract:
// the request id must survive, and it is seeded outside routing on purpose.
func TestTheRequestLineStillCarriesItsCorrelationFields(t *testing.T) {
	traceRecorder(t)

	var logs bytes.Buffer
	router := tracingRouter(t, &logs)

	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/v1/probe", nil)
	// A WELL-FORMED id: ResolveRequestID validates the header against the
	// req_ nanoid pattern and silently generates a fresh one otherwise (it is
	// attacker-controlled input copied onto every line of the flow), so a
	// made-up string here would be discarded and prove nothing.
	req.Header.Set("x-request-id", "req_AbCdEfGhIjKlMnOpQrStUvWx")
	req.Header.Set("x-user-id", "sub-ordering-check")

	router.ServeHTTP(httptest.NewRecorder(), req)

	line := findLogLine(t, logs.Bytes(), "request completed")
	if got, _ := line["request_id"].(string); got != "req_AbCdEfGhIjKlMnOpQrStUvWx" {
		t.Errorf("request_id = %q, want the inbound one", got)
	}
	if got, _ := line["cognito_sub"].(string); got != "sub-ordering-check" {
		t.Errorf("cognito_sub = %q, want the inbound one", got)
	}
}

// TestA404StillGetsARequestLine pins that moving otelgin outward did not push
// LogContextMiddleware inside routing. A router 404 reaches no handler, and its
// line is one of the ones people ask about most.
func TestA404StillGetsARequestLine(t *testing.T) {
	traceRecorder(t)

	var logs bytes.Buffer
	router := tracingRouter(t, &logs)

	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/v1/no-such-route", nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)

	if recorder.Code != nethttp.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
	line := findLogLine(t, logs.Bytes(), "request completed")
	if got, _ := line["http_response_status_code"].(float64); int(got) != nethttp.StatusNotFound {
		t.Errorf("the 404's request line reports status %v, want 404", line["http_response_status_code"])
	}
}

// findLogLine returns the first JSON log record whose msg matches.
func findLogLine(t *testing.T, raw []byte, msg string) map[string]any {
	t.Helper()

	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			continue
		}
		if record["msg"] == msg || record["message"] == msg {
			return record
		}
	}
	t.Fatalf("no %q line in the log output:\n%s", msg, string(raw))
	return nil
}

// ─── The construction-order constraint ───────────────────────────────────────

// TestOtelginSnapshotsTheGlobalsAtConstruction pins a production ordering
// requirement that is otherwise invisible.
//
// otelgin.Middleware() resolves otel.GetTracerProvider() and
// otel.GetTextMapPropagator() ONCE, at construction, and closes over the result
// for the life of the handler. OTel's default global propagator is a NO-OP whose
// Fields() is empty — it extracts nothing at all.
//
// So NewAppRouter MUST be called AFTER SetupTracing. Inverted, the router would
// capture the no-op propagator permanently, every inbound traceparent would be
// discarded, and no later otel.SetTextMapPropagator would repair it. cmd/server
// gets this right (SetupTracing runs long before the router is built), but
// nothing enforced it, and the symptom would be indistinguishable from the gap
// this file exists to close.
//
// This test demonstrates the failure directly: build the router while the
// globals are still the defaults, install the real propagator afterwards, and
// watch the inbound trace id be ignored anyway.
func TestOtelginSnapshotsTheGlobalsAtConstruction(t *testing.T) {
	// Deliberately NOT traceRecorder: the point is to construct the router while
	// the global propagator extracts nothing, which is OTel's default state.
	//
	// An EMPTY composite rather than otel.SetTextMapPropagator(nil): passing nil
	// actually stores nil and the middleware then nil-dereferences on the first
	// request, which is a property of this test's setup and not of anything the
	// service does. The empty composite reproduces the real default — Extract is
	// a no-op and Fields() is empty — without the crash.
	previousPropagator := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator())

	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previousProvider := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	tracing.SetTracerProvider(tp)
	t.Cleanup(func() {
		_ = tp.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
		tracing.SetTracerProvider(previousProvider)
		otel.SetTextMapPropagator(previousPropagator)
	})

	// Router built FIRST, with the no-op propagator in place.
	router := tracingRouter(t, &bytes.Buffer{})

	// The real propagator installed only afterwards — too late.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	const inboundTraceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/v1/probe", nil)
	req.Header.Set("traceparent", "00-"+inboundTraceID+"-00f067aa0ba902b7-01")
	router.ServeHTTP(httptest.NewRecorder(), req)

	spans := exporter.GetSpans().Snapshots()
	if len(spans) == 0 {
		t.Fatal("no spans at all; this test is no longer exercising what it describes")
	}

	adopted := false
	for _, span := range spans {
		if span.SpanContext().TraceID().String() == inboundTraceID {
			adopted = true
		}
	}
	if adopted {
		t.Skip("otelgin now resolves the propagator per request rather than at " +
			"construction; the SetupTracing-before-NewAppRouter ordering in " +
			"cmd/server/main.go is no longer load-bearing for propagation")
	}

	// The documented behaviour: the late propagator had no effect, which is
	// exactly why main.go must call SetupTracing first.
	t.Log("confirmed: otelgin captured the no-op propagator at construction, so " +
		"the inbound traceparent was discarded. cmd/server must keep calling " +
		"SetupTracing before NewAppRouter.")
}
