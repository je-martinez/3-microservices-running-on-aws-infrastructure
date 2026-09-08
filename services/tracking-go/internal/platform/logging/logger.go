package logging

// ServiceName is this service's service_name on every log line, and the value
// of OTEL_SERVICE_NAME in the Dockerfile. One spelling, one place.
const ServiceName = "tracking"

// CONTRACT: Do NOT add an Install() here. This package cannot build the real
// process logger — the trace layer lives in adapter/otel, which it must never
// import — so an almost-right constructor here emits valid JSON with the
// correlation fields and NO trace_id, a silent half-failure. The one complete
// constructor lives in cmd/server/logging_wiring.go. See [[logging-context]]
