package main

import (
	"io"
	"log/slog"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// THE COMPOSITION ROOT IS WHERE THE TWO LOG ENRICHERS MEET.
//
// Neither package may apply both:
//   - internal/platform/logging must not import internal/adapter/otel. It defines
//     the log SCHEMA every runtime shares; making it depend on the OTel SDK would
//     drag that SDK into everything that logs, including code paths that must
//     keep working with tracing disabled entirely.
//   - internal/adapter/otel must not import logging. NewTraceHandler takes an
//     slog.Handler and returns one precisely so it composes from the outside.
//
// So the seam is here, in the one file that already imports both.
//
// # WRAPPER ORDER, and why it is this one
//
// The stack, outermost first:
//
//	TraceHandler  ->  ContextHandler  ->  logging.Handler (the JSON renderer)
//
// Each wrapper appends ITS fields AFTER the record's existing ones, and the JSON
// renderer keeps the FIRST occurrence of a key. So the resulting precedence,
// highest first, is:
//
//	call-site attrs  >  ambient log context  >  trace ids
//
// That is the order we want, and it is the one both Python filters produce
// (`if not hasattr(record, key)` — first writer wins). Reading it as a stack:
// TraceHandler sees the raw record, appends nothing that could shadow a call
// site, and hands the enriched record inward; ContextHandler then appends the
// request's fields behind the call site's; the renderer resolves the conflicts.
//
// SWAPPING THE TWO IS OBSERVABLE ONLY IN KEY ORDER TODAY — measured, not
// assumed. A mutation check that inverted the wrappers produced byte-different
// JSON (span_id lands after request_id instead of before) with every VALUE
// identical, and no test failed. That is because the two layers write DISJOINT
// keys: logging's allow-list admits exactly seven, and trace_id/span_id are not
// among them, so the renderer's first-occurrence-wins rule never has to choose
// between the two enrichers.
//
// That disjointness is a property of today's allow-list, not a law, so it is
// pinned by TestTheTwoEnrichersWriteDisjointKeys. The moment trace_id becomes an
// accepted context key, the outer wrapper's value wins and this order stops
// being cosmetic — an ambient trace_id would shadow the real span's. The test
// fails at that commit, which is when this decision needs re-making.
//
// Given the values do not depend on it, the order is chosen for the two reasons
// below rather than left to chance.
//
// TraceHandler goes OUTERMOST for one more reason: it is the only one of the two
// that reads the OTel context, and keeping the OTel-aware layer at the boundary
// keeps the SDK-free core (the schema renderer plus the context merge) intact
// underneath it. Turn tracing off and the inner two behave identically.
//
// # WHY THIS IS NOT A logging.New OPTION
//
// logging.New already applies ContextHandler, because a logger built without it
// fails SILENTLY — valid JSON, no correlation fields, nobody notices for weeks.
// The trace layer cannot live there for the import reason above, so this
// function is the default path for the PROCESS, and cmd/server is the only place
// that builds a logger for it.
func newProcessLogger(w io.Writer, deploymentEnvironment string) *slog.Logger {
	// logging.New returns a *slog.Logger whose handler is already
	// ContextHandler(logging.Handler). Wrapping that handler puts TraceHandler on
	// the outside, which is the order documented above.
	base := logging.New(w, logging.ServiceName, deploymentEnvironment)
	return slog.New(tracing.NewTraceHandler(base.Handler()))
}

// installProcessLogger builds the process logger and makes it the DEFAULT.
//
// Pointing slog.Default at it is not a convenience: it is what makes the
// enrichment unconditional. A package that reaches for slog.InfoContext with no
// logger of its own — a library, a deep call site, anything not handed one
// through a constructor — still emits the schema WITH the correlation fields and
// the trace ids.
//
// This mirrors the Python, which attaches LogContextFilter and TraceContextFilter
// to the single root HANDLER rather than to individual loggers
// (services/tracking/src/shared/logging/config.py), for exactly this reason: a
// filter on a logger only sees records logged through that logger, while one on
// the handler sees everything that reaches it — including uvicorn's and
// SQLAlchemy's records. Wrapping the HANDLER here (rather than decorating a
// logger) is the Go form of the same decision, and slog.SetDefault is what gives
// it the same reach.
func installProcessLogger(w io.Writer, deploymentEnvironment string) *slog.Logger {
	log := newProcessLogger(w, deploymentEnvironment)
	slog.SetDefault(log)
	return log
}
