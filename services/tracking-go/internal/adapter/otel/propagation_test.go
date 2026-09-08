package otel_test

import (
	"context"
	"sort"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	oteltrace "go.opentelemetry.io/otel/trace"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
)

// The PROPAGATOR half of SetupTracing, which BOTH ends depend on.
//
// CONTRACT: An empty composite passes every "is it traced?" assertion. Broken,
// otelgin extracts no inbound traceparent so every request starts a new trace,
// and the SQS publisher injects none so the pipeline's spans hang off nothing —
// in both directions SEVERAL COMPLETE TRACES instead of one.
// See [[ADR-0019-distributed-tracing-opentelemetry]]

// TestSetupTracingInstallsTheW3CPropagator pins the contract by its OBSERVABLE
// behaviour — the header names it carries — rather than by its Go type.
//
// Asserting the concrete type would pass for any composite while saying nothing
// about whether traceparent actually survives; Fields() is what the other
// runtimes and the gateway actually agree on.
func TestSetupTracingInstallsTheW3CPropagator(t *testing.T) {
	restore := otel.GetTextMapPropagator()
	t.Cleanup(func() { otel.SetTextMapPropagator(restore) })

	// Deliberately start from a propagator that does nothing, so a SetupTracing
	// that installed nothing would leave this state visible instead of
	// inheriting a correct one from another test.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator())

	// OTLP export is irrelevant here and the collector is not running; an
	// exporter error must not stop the propagator assertion, and SetupTracing
	// installs the propagator regardless.
	shutdown, err := tracing.SetupTracing(context.Background())
	if err != nil {
		t.Fatalf("SetupTracing: %v", err)
	}
	t.Cleanup(func() { _ = shutdown(context.Background()) })

	fields := otel.GetTextMapPropagator().Fields()
	sort.Strings(fields)

	// traceparent is the one that MUST be there: it is what the gateway sends
	// inbound and what the events-pipeline reads off the SQS message attribute.
	if !contains(fields, "traceparent") {
		t.Errorf("the global propagator carries %v, missing `traceparent` — "+
			"inbound extraction and outbound injection are BOTH dead, and the "+
			"symptom is several disconnected traces rather than an error", fields)
	}
	// baggage travels with it in the composite the other services install.
	if !contains(fields, "baggage") {
		t.Errorf("the global propagator carries %v, missing `baggage`", fields)
	}
}

// TestTheInstalledPropagatorRoundTripsATraceContext proves the propagator does
// the JOB, not merely that it advertises the right header names.
//
// Inject into a carrier, extract from it, and the trace id must survive. A
// propagator that listed traceparent in Fields() but dropped the value would
// pass the test above and fail this one.
func TestTheInstalledPropagatorRoundTripsATraceContext(t *testing.T) {
	restore := otel.GetTextMapPropagator()
	t.Cleanup(func() { otel.SetTextMapPropagator(restore) })
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator())

	shutdown, err := tracing.SetupTracing(context.Background())
	if err != nil {
		t.Fatalf("SetupTracing: %v", err)
	}
	t.Cleanup(func() { _ = shutdown(context.Background()) })

	traceID, err := oteltrace.TraceIDFromHex("4bf92f3577b34da6a3ce929d0e0e4736")
	if err != nil {
		t.Fatalf("TraceIDFromHex: %v", err)
	}
	spanID, err := oteltrace.SpanIDFromHex("00f067aa0ba902b7")
	if err != nil {
		t.Fatalf("SpanIDFromHex: %v", err)
	}
	source := oteltrace.ContextWithSpanContext(context.Background(),
		oteltrace.NewSpanContext(oteltrace.SpanContextConfig{
			TraceID:    traceID,
			SpanID:     spanID,
			TraceFlags: oteltrace.FlagsSampled,
			Remote:     true,
		}))

	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(source, carrier)

	if carrier["traceparent"] == "" {
		t.Fatal("nothing was injected: the propagator writes no traceparent, so " +
			"the SQS publisher's message attributes would carry none either")
	}

	extracted := oteltrace.SpanContextFromContext(
		otel.GetTextMapPropagator().Extract(context.Background(), carrier))

	if got := extracted.TraceID().String(); got != traceID.String() {
		t.Errorf("the trace id did not survive the round trip: got %s, want %s", got, traceID)
	}
	if !extracted.IsRemote() {
		t.Error("the extracted span context is not marked remote; it did not come from the carrier")
	}
}

func contains(haystack []string, needle string) bool {
	for _, item := range haystack {
		if item == needle {
			return true
		}
	}
	return false
}
