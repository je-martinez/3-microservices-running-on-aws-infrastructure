package main

import (
	"io"
	"log/slog"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// CONTRACT: Do NOT move OTel into internal/platform/logging or omit either
// wrapper. Compose TraceHandler -> ContextHandler -> JSON renderer here so the
// shared logging package remains SDK-free; omission yields valid JSON without
// correlation fields. First-key-wins preserves call-site > ambient > trace
// precedence, and the disjoint-key test guards future overlap.
// See [[logging-context]]
func newProcessLogger(w io.Writer, deploymentEnvironment string) *slog.Logger {
	// logging.New returns a *slog.Logger whose handler is already
	// ContextHandler(logging.Handler). Wrapping that handler puts TraceHandler on
	// the outside, which is the order documented above.
	base := logging.New(w, logging.ServiceName, deploymentEnvironment)
	return slog.New(tracing.NewTraceHandler(base.Handler()))
}

// installProcessLogger builds the process logger and makes it the DEFAULT.
//
// CONTRACT: Do NOT leave the enriched logger local to constructors. Setting the
// process default ensures deep and library call sites carry shared context;
// otherwise they emit bare records.
// See [[logging-context]]
func installProcessLogger(w io.Writer, deploymentEnvironment string) *slog.Logger {
	log := newProcessLogger(w, deploymentEnvironment)
	slog.SetDefault(log)
	return log
}
