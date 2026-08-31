package main

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/go-sql-driver/mysql"
)

// THE DATABASE DRIVER HAS ITS OWN LOGGER, AND IT DOES NOT KNOW slog EXISTS.
//
// # The regression
//
// Observed in the running container, verbatim:
//
//	[mysql] 2026/08/29 03:24:30 connection.go:801 closing bad idle connection: unexpected read from socket
//
// go-sql-driver/mysql carries a PACKAGE-LEVEL logger (errors.go:40), defaulting
// to the standard log package writing to os.Stderr. Nothing about installing an
// slog handler reaches it — slog.SetDefault redirects code that CALLS slog, and
// this driver never does. Measured: 493 log lines from this service, exactly one
// of them non-JSON, and it was this one. Users and Orders emit zero.
//
// # Why one line matters
//
// A non-JSON line carries no service_name, no severity_text, no trace_id and
// none of the shared context fields, so the collector cannot classify it and
// routes it to the `unclassified` stream. This repo treats a growing
// `unclassified` stream as a visible defect — that is what
// e2e/tests/observability/unclassified-logs.spec.ts asserts, and this line is a
// producer that trips it. The Python service did not have this problem because
// it re-pointed uvicorn's and SQLAlchemy's loggers at the root handler for
// exactly this reason; this is the Go form of that same decision.
//
// # WHY THIS LIVES IN THE COMPOSITION ROOT
//
// mysql.SetLogger writes a PACKAGE-LEVEL variable in a third-party package. It
// is process-global install-once state of precisely the same kind as
// slog.SetDefault, and this service's rule is that such decisions are made in
// one readable place — see logging_wiring.go, immediately beside this file.
//
// It deliberately does NOT live in internal/adapter/mysql. That package's
// constructors are per-pool (NewTrackingRepository, NewTrackingReader,
// NewStatusRepository, NewSoftDeleteRepository, NewMetricsRepository) and each
// is called more than once, so a global installed from there would be installed
// repeatedly, from whichever repository happened to be constructed first, and
// its effect would depend on construction order. Worse, it would be invisible
// from the composition root: a reader auditing what this process installs
// globally would have to go looking inside an adapter to find it. The rule the
// rest of this root follows — the composition root decides what exists — applies
// unchanged.
//
// # THE ORDERING CONSTRAINT IS REAL, not stylistic
//
// It must run BEFORE the pools are opened. ParseDSN copies the package-level
// defaultLogger into the per-connection Config (dsn.go:229-231), so a connection
// whose DSN was parsed before SetLogger keeps the STDERR logger for its entire
// life — and the fix would appear to work while the connections that actually
// log kept bypassing it. run() calls this immediately after
// installProcessLogger and before openPool for that reason.
//
// # And it is pinned by the reachability gate
//
// "Correct code, absent wiring" has bitten this migration repeatedly, and an
// unwired logger adapter is exactly that shape: the adapter would be fully
// unit-tested, the driver would keep writing plain text to stderr, and nothing
// would fail. installDriverLogging is therefore an entry in requiredSeams.

// driverLogAppEvent tags every line the driver produced.
//
// Once the message is JSON it no longer carries the "[mysql] " prefix the
// standard logger prepended, so without this field a reader cannot tell a driver
// line from one this service wrote itself. It is an app_event rather than a
// bespoke key because that is the field the repo's flow logs already use and
// dashboards already select on.
const driverLogAppEvent = "mysql_driver_log"

// mysqlSlogLogger adapts mysql.Logger (Print(v ...any)) onto an *slog.Logger.
//
// # WARN, not INFO
//
// The driver logs through this path only on genuine trouble: a bad idle
// connection being closed, an auth plugin that could not be used, a packet-level
// fault. "closing bad idle connection" is a real event worth seeing — it is a
// connection the pool believed was healthy and was not. INFO would bury it among
// the request lines; ERROR would overstate it, since database/sql recovers by
// retrying on a fresh connection and no request failed.
type mysqlSlogLogger struct{ log *slog.Logger }

// Print implements mysql.Logger.
//
// # fmt.Sprint, NEVER Sprintf
//
// The driver splits one message across several arguments — connection.go:65
// prepends a "file:line " prefix and passes the rest through — so the whole
// variadic must be joined, not just v[0]. And slog takes a MESSAGE, not a format
// string: a DSN or a server error carrying a literal % would render as
// %!d(MISSING) under Sprintf, corrupting the diagnostic exactly when the
// connection string is the thing you need to read.
//
// fmt.Sprint adds spaces only between operands when NEITHER is a string, which
// reproduces the standard logger's rendering of these calls: the driver's own
// arguments already end in ": " or " " where a separator is wanted.
func (l mysqlSlogLogger) Print(v ...any) {
	message := strings.TrimSpace(fmt.Sprint(v...))
	if message == "" {
		return
	}
	// context.Background(), not a request's: this is called from deep inside the
	// driver's connection handling, with no context available and often from a
	// pool goroutine that belongs to no request at all. The line therefore
	// carries no trace_id, and that is correct — OMITTED, never zeroed.
	l.log.LogAttrs(context.Background(), slog.LevelWarn, message,
		slog.String("app_event", driverLogAppEvent))
}

// installDriverLogging routes go-sql-driver/mysql's package-level logger through
// the process logger.
//
// A nil logger is IGNORED rather than installed: mysql.SetLogger rejects nil
// with an error, and a driver left on its stderr default is the regression this
// function exists to remove — silently swallowing the driver's output instead
// would be strictly worse than the plain-text line.
func installDriverLogging(log *slog.Logger) {
	if log == nil {
		return
	}
	// The error is only ever "logger is nil", which the guard above already
	// excludes. Failing to redirect a log line is never a reason to fail to boot.
	_ = mysql.SetLogger(mysqlSlogLogger{log: log})
}
