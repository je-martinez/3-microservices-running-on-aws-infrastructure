package logging

// ServiceName is this service's service_name on every log line, and the value
// of OTEL_SERVICE_NAME in the Dockerfile. One spelling, one place.
const ServiceName = "tracking"

// There is deliberately NO Install() here.
//
// There was one: it built New(os.Stdout, ServiceName, env) and called
// slog.SetDefault. It was removed when the composition root took over installing
// the process logger, because this package cannot build the REAL one — the trace
// layer lives in internal/adapter/otel, which this package must never import (it
// defines the log schema every runtime shares; making it depend on the OTel SDK
// would drag that SDK into everything that logs).
//
// Keeping a second, almost-right constructor here would be an invitation to call
// it: a process wired through it emits perfectly valid JSON carrying the
// correlation fields and NO trace_id — the exact silent half-failure this
// service already shipped once. One constructor for the process, in
// cmd/server/logging_wiring.go, and it is the complete one.
