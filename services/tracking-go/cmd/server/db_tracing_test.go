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

// The SQL half of the tracing wiring. Wrapping the driver turns "this request
// was slow" into "slow IN THIS QUERY"; without it a workflow span shows a gap
// with nothing inside it.
//
// CONTRACT: The seam is openPool, not the repositories. Every repository takes a
// plain *sql.DB and otelsql.Open returns one, so instrumenting the ONE place
// pools are opened leaves no second uninstrumented way to open one.
// See [[ADR-0019-distributed-tracing-opentelemetry]]

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

// TestOpenPoolProducesDatabaseSpans asserts otelsql is wired at all — the part
// that silently regresses. The pool points at a dead port so the query fails,
// which proves the instrumentation sits around the driver rather than depending
// on a live server.
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

// TestDatabaseSpansCarryNoQueryText is a PII regression test pinning a default
// that works against us: otelsql records db.query.text unless told not to, and
// this service's writes carry shipping_address. It fails if DisableQuery is
// dropped or a future otelsql changes the default back. See [[logging-context]]
//
// CONTRACT: Use the FAKE DRIVER, not the real pool. The query span is created
// only once a connection exists, so against a dead address the driver fails at
// connect and this passes whether DisableQuery is set or not — a vacuous test.
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

// openInstrumentedFakePool wraps a driver that CONNECTS and executes, so a query
// span is really produced, using the SAME options openPool applies.
//
// CONTRACT: Take the options from poolTracingOptions(), never a duplicated
// literal — a restated set can silently stop matching production.
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

// TestDatabaseSpansDoNotRecordErrSkip pins the second otelsql default working
// against us — the mirror of the PII test: absent from the EVENTS and STATUS
// rather than the attributes.
//
// CONTRACT: driver.ErrSkip is a database/sql sentinel, not a failure, and
// go-sql-driver returns it for every parameterized statement here. Recorded, the
// traces fill with exceptions for something that never went wrong, which teaches
// readers that errors on DB spans are normal. The fake driver mimics
// go-sql-driver rather than inventing a case, so the sentinel travels the real
// code path. See [[logging-context]]
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

// CONTRACT: Prepare must SUCCEED. database/sql answers ErrSkip by falling back
// to prepare-then-exec, and a failing Prepare puts a genuine error on the
// fallback's own span — the tests would then assert against that failure rather
// than ErrSkip. See [[logging-context]]
func (errSkipConn) Prepare(string) (driver.Stmt, error) { return errSkipStmt{}, nil }

type errSkipStmt struct{}

func (errSkipStmt) Close() error                               { return nil }
func (errSkipStmt) NumInput() int                              { return -1 }
func (errSkipStmt) Exec([]driver.Value) (driver.Result, error) { return driver.RowsAffected(1), nil }
func (errSkipStmt) Query([]driver.Value) (driver.Rows, error)  { return nil, io.EOF }

// TestDatabaseMetricsDoNotCountErrSkipAsAnError is the METRICS half of the same
// non-event, separate because it fails on a separate option.
//
// CONTRACT: DisableErrSkip governs SPANS only. Without DisableSkipErrMeasurement
// every fast-path fallback counts as a failed database call, so one flag alone
// leaves the waterfall and dashboard disagreeing over one non-event.
// See [[logging-context]]
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
