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
	"go.opentelemetry.io/otel/codes"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	semconv "go.opentelemetry.io/otel/semconv/v1.38.0"
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

// TestDatabaseSpansDoNotRecordErrSkip pins the second otelsql default that works
// against us, and it is the mirror image of the PII one above: that test asserts
// something is ABSENT from the attributes, this one asserts something is absent
// from the EVENTS and the STATUS.
//
// driver.ErrSkip is a database/sql SENTINEL, not a failure. A driver returns it
// to say "I do not implement this optional fast path, use the generic one", and
// database/sql then falls back and the call succeeds. go-sql-driver/mysql
// returns it in the ORDINARY course of business — mysqlConn.Exec and
// mysqlConn.query both return it whenever a statement carries arguments and
// InterpolateParams is off, which is the default and therefore every
// parameterized statement this service runs. otelsql's own conn.go returns it
// too, from every optional interface the wrapped driver does not implement.
//
// otelsql nevertheless calls span.RecordError + SetStatus(codes.Error) on it,
// so traces fill with exception events for something that never went wrong.
// That is worse than noise: it teaches whoever reads the waterfall that errors
// on DB spans are normal, which is precisely when a real one gets scrolled past,
// and the error status makes successful spans render as failed.
//
// # THE FAKE DRIVER MIMICS go-sql-driver/mysql, IT DOES NOT INVENT A CASE
//
// errSkipConn.ExecContext returns driver.ErrSkip exactly as mysqlConn does with
// args and no interpolation. otelsql wraps that call in sql.conn.exec and passes
// the returned error to recordSpanError, so the sentinel travels the real code
// path — this is an observation of a genuine ErrSkip span, not an assertion
// about a boolean field.
func TestDatabaseSpansDoNotRecordErrSkip(t *testing.T) {
	spansOf := dbSpanRecorder(t)

	db := otelsql.OpenDB(errSkipConnector{}, poolTracingOptions()...)
	t.Cleanup(func() { _ = db.Close() })

	// database/sql swallows ErrSkip and falls back to prepare-then-exec, which
	// this fake ALLOWS TO SUCCEED — so the statement below succeeds, exactly as
	// it does against MySQL. That is the whole point of the assertion: a span
	// was being marked as an error for a call that worked.
	//nolint:errcheck // the span, not the result, is the assertion.
	_, _ = db.ExecContext(context.Background(),
		"UPDATE trackings SET status = ? WHERE order_id = ?",
		"SHIPPED", "ord_errskip_probe")

	var sawExecSpan bool
	for _, span := range spansOf() {
		if span.Name() != "sql.conn.exec" {
			continue
		}
		sawExecSpan = true

		for _, event := range span.Events() {
			if event.Name == semconv.ExceptionEventName {
				t.Errorf("span %q records an exception event for driver.ErrSkip — "+
					"ErrSkip is a database/sql control-flow sentinel meaning "+
					"\"fast path not implemented, use the generic one\", not a failure; "+
					"poolTracingOptions must keep passing "+
					"otelsql SpanOptions{DisableErrSkip: true}", span.Name())
			}
		}
		if span.Status().Code == codes.Error {
			t.Errorf("span %q has status ERROR (%q) for driver.ErrSkip — "+
				"a successful query would render as a failed span; "+
				"poolTracingOptions must keep passing "+
				"otelsql SpanOptions{DisableErrSkip: true}",
				span.Name(), span.Status().Description)
		}
	}

	// Without this the test would pass by never producing the span at all —
	// the vacuous shape the PII test above already had to be rescued from.
	if !sawExecSpan {
		t.Fatal("no sql.conn.exec span was produced, so no ErrSkip ever reached a " +
			"span; this test is not exercising the path it claims to guard")
	}
}

// errSkipConnector's connection declines the ExecContext fast path the way
// go-sql-driver/mysql declines it: by returning driver.ErrSkip.
type errSkipConnector struct{}

func (errSkipConnector) Connect(context.Context) (driver.Conn, error) { return errSkipConn{}, nil }
func (errSkipConnector) Driver() driver.Driver                        { return errSkipDriver{} }

type errSkipDriver struct{}

func (errSkipDriver) Open(string) (driver.Conn, error) { return errSkipConn{}, nil }

type errSkipConn struct{}

func (errSkipConn) Close() error              { return nil }
func (errSkipConn) Begin() (driver.Tx, error) { return nil, io.EOF }

func (errSkipConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	return nil, driver.ErrSkip
}

// Prepare SUCCEEDS, and that is not incidental. database/sql answers ErrSkip by
// falling back to prepare-then-exec, which is what really happens against MySQL:
// the fast path is declined, the statement is prepared, and the call SUCCEEDS.
// A Prepare that failed here would put a genuine error on the fallback's own
// span and measurement — measured: it stamped
// error.type="*errors.errorString" on db.client.operation.duration — and the
// tests would then be asserting against that failure rather than against
// ErrSkip, which is the one thing they exist to isolate.
func (errSkipConn) Prepare(string) (driver.Stmt, error) { return errSkipStmt{}, nil }

type errSkipStmt struct{}

func (errSkipStmt) Close() error                               { return nil }
func (errSkipStmt) NumInput() int                              { return -1 }
func (errSkipStmt) Exec([]driver.Value) (driver.Result, error) { return driver.RowsAffected(1), nil }
func (errSkipStmt) Query([]driver.Value) (driver.Rows, error)  { return nil, io.EOF }

// TestDatabaseMetricsDoNotCountErrSkipAsAnError is the METRICS half of the same
// non-event, and it exists as a separate test because it fails on a separate
// option.
//
// DisableErrSkip governs SPANS only. Left to its default,
// DisableSkipErrMeasurement stamps error.type="database/sql/driver.ErrSkip" on
// the db.client.operation.duration measurement, so every fast-path fallback is
// counted as a failed database call. Setting one flag and not the other is the
// worst of the three states: the trace waterfall would say the query was fine
// while the dashboard said it errored, over the same non-event, and whoever
// noticed the disagreement would have to rediscover ErrSkip from scratch to
// resolve it.
//
// Measured through a real SDK reader rather than by reading the option back,
// for the same reason as the span test: the assertion is what the collector
// receives.
func TestDatabaseMetricsDoNotCountErrSkipAsAnError(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previous := otel.GetMeterProvider()
	otel.SetMeterProvider(mp)
	t.Cleanup(func() {
		_ = mp.Shutdown(context.Background())
		otel.SetMeterProvider(previous)
	})

	db := otelsql.OpenDB(errSkipConnector{}, poolTracingOptions()...)
	t.Cleanup(func() { _ = db.Close() })

	//nolint:errcheck // the recorded measurement, not the result, is the assertion.
	_, _ = db.ExecContext(context.Background(),
		"UPDATE trackings SET status = ? WHERE order_id = ?",
		"SHIPPED", "ord_errskip_probe")

	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
		t.Fatalf("collecting metrics: %v", err)
	}

	var sawDurationPoint bool
	for _, scope := range collected.ScopeMetrics {
		for _, m := range scope.Metrics {
			histogram, ok := m.Data.(metricdata.Histogram[float64])
			if !ok {
				continue
			}
			for _, point := range histogram.DataPoints {
				sawDurationPoint = true
				if errorType, present := point.Attributes.Value("error.type"); present {
					t.Errorf("metric %q carries error.type=%q for driver.ErrSkip — "+
						"a fast-path fallback is being counted as a failed database "+
						"call, so the dashboard disagrees with the trace over the "+
						"same non-event; poolTracingOptions must keep passing "+
						"otelsql.WithDisableSkipErrMeasurement(true)",
						m.Name, errorType.AsString())
				}
			}
		}
	}

	if !sawDurationPoint {
		t.Fatal("no duration histogram point was recorded, so no ErrSkip ever " +
			"reached a measurement; this test is not exercising the path it " +
			"claims to guard")
	}
}
