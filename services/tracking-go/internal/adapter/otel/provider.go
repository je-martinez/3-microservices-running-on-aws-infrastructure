// Package otel wires OpenTelemetry for this service: otelgin for inbound HTTP,
// otelsql around the driver, otelgrpc on the outbound client, and a
// hand-instrumented SQS producer. Logs and traces both reach OpenObserve.
//
// CONTRACT: Configuration goes in ENVIRONMENT VARIABLES, never code —
// OTEL_EXPORTER_OTLP_ENDPOINT and _PROTOCOL, OTEL_METRICS_EXPORTER=none,
// OTEL_LOGS_EXPORTER=none, OTEL_SERVICE_NAME. An SDK option whose value came out
// empty loses to auto-detection with no error at all.
// See [[ADR-0019-distributed-tracing-opentelemetry]]
package otel

import (
	"context"
	nethttp "net/http"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	oteltrace "go.opentelemetry.io/otel/trace"
)

// Tracer names, exactly as the other services spell them. One query in
// OpenObserve must mean the same thing in every runtime.
const (
	TracerWorkflow  = "tracking-workflow"
	TracerMessaging = "tracking-messaging"
	TracerMetrics   = "tracking-metrics"
	TracerCache     = "tracking-cache"
)

// HealthRoute is excluded from tracing. Python does this with
// OTEL_PYTHON_FASTAPI_EXCLUDED_URLS="/v1/health$"; Go has no such variable, so
// the exclusion is a filter passed to otelgin.
const HealthRoute = "/v1/health"

// provider is the tracer provider these helpers read from. Package-level rather
// than a parameter so a use case can open a workflow span without being handed
// a provider through every constructor; tests swap it with SetTracerProvider.
var provider oteltrace.TracerProvider = otel.GetTracerProvider()

// SetTracerProvider points the helpers at tp. Used by SetupTracing and by tests.
func SetTracerProvider(tp oteltrace.TracerProvider) { provider = tp }

// Tracer returns a named tracer from the configured provider.
func Tracer(name string) oteltrace.Tracer { return provider.Tracer(name) }

// SetupTracing installs the OTLP exporter and the W3C propagator. Its returned
// shutdown flushes pending spans; without it the last batch never leaves.
//
// CONTRACT: Pass no endpoint, protocol or header — otlptracehttp.New reads
// OTEL_EXPORTER_OTLP_*, and an explicit empty option loses to auto-detection
// with no error at all.
func SetupTracing(ctx context.Context) (func(context.Context) error, error) {
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}

	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter))
	otel.SetTracerProvider(tp)
	SetTracerProvider(tp)

	// W3C trace context plus baggage: the same propagator the SQS publisher
	// injects with and the events-pipeline extracts with.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return tp.Shutdown, nil
}

// GinFilter reports whether a request should be traced. Returns false for the
// liveness probe, which runs forever at a fixed interval and would otherwise be
// most of the spans this service produces.
func GinFilter(req *nethttp.Request) bool {
	return req.URL.Path != HealthRoute
}
