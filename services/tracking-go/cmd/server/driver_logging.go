package main

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/go-sql-driver/mysql"
)

// CONTRACT: Do NOT rely on slog.SetDefault for go-sql-driver/mysql or install
// this adapter after opening pools. The driver owns a package-level logger, and
// ParseDSN snapshots it into each connection; late or absent installation emits
// plain-text records without service_name, severity, or trace_id into the
// `unclassified` stream. Keep this process-global decision in the composition
// root and in the reachability inventory.
// See [[logging-context]]

// driverLogAppEvent tags every line the driver produced.
//
// WHY: app_event preserves the driver origin after the standard logger's prefix
// is removed and remains queryable by existing dashboards.
const driverLogAppEvent = "mysql_driver_log"

// mysqlSlogLogger adapts mysql.Logger (Print(v ...any)) onto an *slog.Logger.
// WHY: WARN keeps connection trouble visible without claiming the request failed;
// database/sql can recover by retrying a fresh connection.
type mysqlSlogLogger struct{ log *slog.Logger }

// Print implements mysql.Logger.
//
// CONTRACT: Do NOT use Sprintf or only v[0]. The driver splits messages across
// arguments, and treating a literal percent sign as formatting corrupts the
// diagnostic. Sprint preserves the driver's standard rendering.
// See [[logging-context]]
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
// WARNING: Ignore nil because SetLogger rejects it; replacing the default with a
// silent logger would lose driver diagnostics entirely.
func installDriverLogging(log *slog.Logger) {
	if log == nil {
		return
	}
	// The error is only ever "logger is nil", which the guard above already
	// excludes. Failing to redirect a log line is never a reason to fail to boot.
	_ = mysql.SetLogger(mysqlSlogLogger{log: log})
}
