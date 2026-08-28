package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"testing"

	"github.com/XSAM/otelsql"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	oteltrace "go.opentelemetry.io/otel/trace"
)

// The SQL half of the tracing wiring.
//
// otelsql was named in provider.go's docstring and in the plan's surface table
// alongside otelgin, and was in exactly the same state: mentioned everywhere,
// wired nowhere. Wrapping the driver is what turns "this request was slow" into
// "this request was slow IN THIS QUERY" — without it a workflow span shows a
// 300ms gap with nothing inside it.
//
// # WHY THE SEAM IS openPool AND NOT THE REPOSITORIES
//
// Every repository takes a plain *sql.DB (NewTrackingRepository, NewStatusRepository,
// NewSoftDeleteRepository, NewMetricsRepository). otelsql.Open returns a *sql.DB
// too, so instrumenting at the ONE place pools are opened covers all four with
// no adapter change and no interface widened — and, more to the point, leaves no
// second uninstrumented way to open a pool that a later repository could reach
// for.

// dbSpanRecorder installs an in-memory exporter as the global provider.
func dbSpanRecorder(t *testing.T) func() []sdktrace.ReadOnlySpan {
	t.Helper()

	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))

	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	t.Cleanup(func() {
		_ = tp.Shutdown(context.Background())
		otel.SetTracerProvider(previous)
	})

	// A CLOSURE, never exporter.GetSpans().Snapshots: that expression evaluates
	// GetSpans() immediately and binds the method value of the snapshot taken
	// before anything ran, so every later call returns an empty slice.
	return func() []sdktrace.ReadOnlySpan { return exporter.GetSpans().Snapshots() }
}

// TestOpenPoolProducesDatabaseSpans is the assertion that otelsql is wired.
//
// The pool points at a port nothing is listening on, so the query FAILS — and
// that is deliberate: the span is emitted either way, and a failing connection
// proves the instrumentation sits around the driver rather than depending on a
// live server. A repository test with real MySQL covers the success path; this
// one covers "is it instrumented at all", which is the part that silently
// regresses.
func TestOpenPoolProducesDatabaseSpans(t *testing.T) {
	spansOf := dbSpanRecorder(t)

	db, err := openPool("mysql+pymysql://test:test@127.0.0.1:1/tracking")
	if err != nil {
		t.Fatalf("openPool: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// A parent span, so the assertion can also check the DB span hangs off the
	// caller's trace rather than starting one of its own.
	ctx, parent := otel.GetTracerProvider().Tracer("test").Start(context.Background(), "parent")
	//nolint:errcheck // the query is EXPECTED to fail; the span is what is asserted.
	_, queryErr := db.ExecContext(ctx, "SELECT 1")
	parent.End()

	if queryErr == nil {
		t.Fatal("the query unexpectedly succeeded; this test assumes nothing listens on port 1")
	}

	spans := spansOf()
	var dbSpans []sdktrace.ReadOnlySpan
	for _, span := range spans {
		if span.SpanKind() == oteltrace.SpanKindClient {
			dbSpans = append(dbSpans, span)
		}
	}
	if len(dbSpans) == 0 {
		names := make([]string, 0, len(spans))
		for _, span := range spans {
			names = append(names, span.Name())
		}
		t.Fatalf("no CLIENT spans from a database call (got %v) — "+
			"otelsql is not wrapping the driver, so queries are invisible inside "+
			"the workflow spans that contain them", names)
	}

	parentTraceID := parent.SpanContext().TraceID().String()
	for _, span := range dbSpans {
		if got := span.SpanContext().TraceID().String(); got != parentTraceID {
			t.Errorf("database span %q is in trace %s, want the caller's %s — "+
				"the query is not a child of the request that issued it",
				span.Name(), got, parentTraceID)
		}
	}
}

// TestOpenPoolStillRejectsABadDSN guards the wrapping from swallowing the DSN
// validation openPool already performs. Instrumentation must not change what a
// misconfiguration does.
func TestOpenPoolStillRejectsABadDSN(t *testing.T) {
	if _, err := openPool("not-a-dsn"); err == nil {
		t.Error("openPool accepted a malformed DSN; the otelsql wrapping must not " +
			"bypass MySQLDSN's validation")
	}
}

// TestOpenPoolDoesNotDial pins the property the health check depends on.
//
// sql.Open does not connect, and neither may the instrumented form: folding a
// connectivity check into startup would make a transient database blip cycle
// otherwise-healthy tasks. otelsql.Open must therefore stay lazy exactly as
// sql.Open is.
func TestOpenPoolDoesNotDial(t *testing.T) {
	db, err := openPool("mysql+pymysql://test:test@127.0.0.1:1/tracking")
	if err != nil {
		t.Fatalf("openPool dialled at open time (or failed for another reason): %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// Proof the address really is dead: the failure must appear on FIRST USE,
	// not at open.
	if pingErr := db.PingContext(context.Background()); pingErr == nil {
		t.Fatal("something is listening on port 1; this test can no longer prove laziness")
	} else if errors.Is(pingErr, context.Canceled) {
		t.Fatalf("unexpected cancellation: %v", pingErr)
	}
}

// TestDatabaseSpansCarryNoQueryText is a PII regression test, and it pins a
// DEFAULT that works against us.
//
// otelsql records db.query.text unless told not to. Verified against v0.43.0
// with no options set, an instrumented UPDATE emitted:
//
//	db.query.text = "UPDATE trackings SET shipping_address='221B Baker Street' ..."
//
// shipping_address is PII by this repo's logging rules, and a span attribute
// reaches the collector and OpenObserve exactly as a log line does — so the
// prohibition is the same one. openPool passes DisableQuery, and this test fails
// if that option is ever dropped or if a future otelsql changes the default back.
//
// # WHY A FAKE DRIVER AND NOT THE REAL POOL
//
// The query span is only created once a CONNECTION EXISTS. Against a dead
// address (openPool's usual test target) the driver fails at sql.connector.connect
// and the query path is never reached — so a version of this test written that
// way passes whether DisableQuery is set or not. Measured: dropping the option
// left it green. It was a vacuous test, which is the very failure mode this task
// is about, so the driver below is what makes the assertion real.
func TestDatabaseSpansCarryNoQueryText(t *testing.T) {
	spansOf := dbSpanRecorder(t)

	db := openInstrumentedFakePool(t)

	//nolint:errcheck // the span attributes are the assertion, not the result.
	_, _ = db.ExecContext(context.Background(),
		"UPDATE trackings SET shipping_address = ? WHERE order_id = ?",
		"221B Baker Street", "ord_pii_probe")

	var sawQuerySpan bool
	for _, span := range spansOf() {
		for _, attr := range span.Attributes() {
			switch string(attr.Key) {
			case "db.query.text", "db.statement":
				t.Errorf("span %q leaks the SQL text in %s = %q — "+
					"this service's write statements carry shipping_address (PII); "+
					"openPool must keep passing otelsql SpanOptions{DisableQuery: true}",
					span.Name(), attr.Key, attr.Value.AsString())
			}
		}
		if span.Name() == "sql.conn.exec" {
			sawQuerySpan = true
		}
	}

	// Without this the test would pass by never reaching the query path at all,
	// which is exactly how the first version of it failed to catch anything.
	if !sawQuerySpan {
		t.Fatal("no sql.conn.exec span was produced, so nothing was actually " +
			"checked for query text; this test is not exercising the query path")
	}
}

// openInstrumentedFakePool wraps a driver that CONNECTS and executes, so the
// query span is really produced — using the SAME option set openPool applies.
//
// The options come from poolTracingOptions(), the one place they are declared,
// so this test cannot drift away from production the way a duplicated literal
// would. openPool hard-codes the mysql driver, which is why the DRIVER is faked
// here while the OPTIONS are shared.
func openInstrumentedFakePool(t *testing.T) *sql.DB {
	t.Helper()

	db := otelsql.OpenDB(fakeConnector{}, poolTracingOptions()...)
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// A minimal driver that succeeds, so the instrumentation reaches its query path.
type fakeConnector struct{}

func (fakeConnector) Connect(context.Context) (driver.Conn, error) { return fakeConn{}, nil }
func (fakeConnector) Driver() driver.Driver                        { return fakeDriver{} }

type fakeDriver struct{}

func (fakeDriver) Open(string) (driver.Conn, error) { return fakeConn{}, nil }

type fakeConn struct{}

func (fakeConn) Prepare(string) (driver.Stmt, error) { return nil, io.EOF }
func (fakeConn) Close() error                        { return nil }
func (fakeConn) Begin() (driver.Tx, error)           { return nil, io.EOF }
func (fakeConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	return driver.RowsAffected(1), nil
}
