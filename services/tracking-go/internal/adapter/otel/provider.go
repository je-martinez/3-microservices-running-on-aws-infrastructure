// Package otel wires OpenTelemetry for this service.
//
// Go has NO `opentelemetry-instrument` equivalent, so every surface the Python
// service got for free must be wired here in code: otelgin for inbound HTTP,
// otelsql around the driver, otelgrpc on the outbound client, and a
// hand-instrumented SQS producer.
//
// What does NOT live in code is the configuration. Endpoint, protocol and the
// disabling of the metrics/logs exporters all come from the standard OTLP
// environment variables, and that is a rule with three recorded silent failures
// behind it in this repo:
//
//	OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:4318
//	OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
//	OTEL_METRICS_EXPORTER=none
//	OTEL_LOGS_EXPORTER=none
//	OTEL_SERVICE_NAME=tracking          (set in the Dockerfile)
//
// Logs and traces BOTH go to OpenObserve; there is no Jaeger any more.
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

// SetupTracing installs the OTLP exporter and the W3C propagator.
//
// No endpoint, protocol or header is passed here: otlptracehttp.New reads them
// from OTEL_EXPORTER_OTLP_*. Passing an SDK option whose value came out
// `undefined` is exactly how the three silent failures happened — an explicit
// option LOSES to auto-detection in a way that produces no error at all.
//
// The returned shutdown flushes pending spans; call it on graceful exit or the
// last batch never leaves the process.
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
