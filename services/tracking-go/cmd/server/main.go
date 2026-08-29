// Command server runs the Tracking HTTP service.
//
// All dependencies are wired BY HAND here — no DI container, no code generation
// for wiring, no reflection. The wiring is a function you can read top to bottom.
//
// # What lives here, and what deliberately does not
//
// This file owns only what CANNOT be tested in-process: reading the environment,
// opening sockets (two database pools, a Redis client, a gRPC channel, the AWS
// clients), starting the background ticker, and shutting all of it down. The
// route table and the middleware chain live in adapterhttp.NewAppRouter, which a
// test can import — so a dropped Register* call fails a unit test at the commit
// that dropped it rather than a gateway E2E hours later. main() cannot be
// imported, so anything decided here is only observable by starting a process.
//
// # The FLAGS are decided here and nowhere else
//
// CACHE_ENABLED, METRICS_ENABLED and EVENTS_QUEUE_URL are each read exactly once,
// in this file, and turned into a DEPENDENCY — a null gateway, a nil publisher, a
// noop publisher. No use case and no middleware branches on a flag. The
// composition root is the one place that decides whether a dependency exists at
// all; everything downstream just uses what it was handed.
package main

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/XSAM/otelsql"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awscw "github.com/aws/aws-sdk-go-v2/service/cloudwatch"
	awssqs "github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/gin-gonic/gin"
	_ "github.com/go-sql-driver/mysql"
	goredis "github.com/redis/go-redis/v9"
	semconv "go.opentelemetry.io/otel/semconv/v1.38.0"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers"
	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
	adaptermysql "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/notify"
	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/config"
)

const (
	shutdownGracePeriod     = 15 * time.Second
	serverReadHeaderTimeout = 10 * time.Second

	// otelShutdownTimeout bounds the final span flush. Short, because it runs
	// AFTER the connections are drained: a collector that has gone away must not
	// hold the process open past its orchestrator's kill timeout.
	otelShutdownTimeout = 5 * time.Second
)

func main() {
	// os.Exit skips deferred functions, so every cleanup lives in run() and the
	// exit code is the only thing decided out here.
	if err := run(); err != nil {
		slog.Error("tracking service exited", slog.String("error", err.Error()))
		os.Exit(1)
	}
}

// run wires every dependency and serves until a signal arrives.
//
// It is ONE long function on purpose. A composition root is a linear list of
// constructions, and its ORDER is the single thing a reader comes here to check;
// splitting it into helpers would hide that order and scatter each resource's
// shutdown away from the line that opened it.
//
//nolint:funlen,gocyclo // see above: the length IS the readable form here.
func run() error {
	// FIRST, before anything can log: structured JSON to stdout. Logs reach
	// OpenObserve through Docker's fluentd driver, and a plain-text line is one
	// no query can select on.
	//
	// DEPLOYMENT_ENVIRONMENT is read from the raw environment rather than through
	// the validated Config, deliberately: failing to log is never a reason to
	// fail to start, so logging must not depend on a fully-valid environment.
	// Same default as Config's.
	deploymentEnvironment := os.Getenv("DEPLOYMENT_ENVIRONMENT")
	if deploymentEnvironment == "" {
		deploymentEnvironment = "local"
	}
	// installProcessLogger is where the two log enrichers meet, and the ONLY
	// constructor that builds the complete one. internal/platform/logging cannot
	// apply the trace layer (its package must not import the OTel adapter), so a
	// logger built there carries the correlation fields but never
	// trace_id/span_id — logs and traces travel different transports and nothing
	// else joins them. See logging_wiring.go for the wrapper order and why it is
	// that one.
	//
	// It runs BEFORE SetupTracing on purpose: TraceHandler reads the ambient span
	// off the context at Handle time, not the provider at construction time, so a
	// logger built now stamps ids correctly the moment spans start flowing — and
	// the startup lines in between (including a tracing_setup_failed warning) are
	// correctly emitted with the trace fields OMITTED rather than zeroed.
	logger := installProcessLogger(os.Stdout, deploymentEnvironment)

	// The DATABASE DRIVER's own package-level logger, redirected onto the one
	// above. go-sql-driver/mysql writes plain text to stderr by default and never
	// calls slog, so slog.SetDefault does not reach it: one measured line in 493
	// escaped as
	//
	//	[mysql] ... closing bad idle connection: unexpected read from socket
	//
	// which the collector cannot classify and files under `unclassified`.
	//
	// BEFORE the pools open, and that order is load-bearing: ParseDSN copies the
	// package-level logger into each connection's Config, so a pool opened first
	// would keep the stderr logger for its whole life while this call appeared to
	// have fixed it. See driver_logging.go.
	installDriverLogging(logger)

	// Config, and a LOUD failure on a missing required variable. Exactly four are
	// required; every optional one has already fallen back to its default by the
	// time Load returns, because refusing to boot over a mistyped feature flag is
	// the worse trade in both directions.
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	if ginMode := os.Getenv("GIN_MODE"); ginMode != "" {
		gin.SetMode(ginMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	// The PROCESS LIFETIME context. NotifyContext cancels it on SIGINT/SIGTERM;
	// SIGTERM is what ECS sends when it drains a task, so handling it is what
	// makes a deploy graceful rather than a burst of dropped connections.
	//
	// EVERY BACKGROUND GOROUTINE DERIVES FROM THIS ONE, never from a request's
	// context: a request context is cancelled the instant its response is sent,
	// which would kill the metrics ticker on the first request it happened to be
	// started from.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// ── OpenTelemetry ────────────────────────────────────────────────────────
	//
	// No endpoint, protocol or header is passed: the SDK reads them from the
	// standard OTEL_EXPORTER_OTLP_* variables. Passing an option whose value came
	// out empty LOSES to auto-detection with no error at all — three silent
	// failures in this repo came from configuring the SDK in code.
	//
	// A failure here is logged and SWALLOWED. Tracing is an observation of the
	// service; a collector that is down must not stop the service from serving.
	shutdownTracing, err := tracing.SetupTracing(ctx)
	if err != nil {
		logger.Warn("tracing_setup_failed",
			slog.String("app_event", "tracing_setup_failed"),
			slog.String("reason", "otlp_exporter_unavailable"),
			slog.String("exception", err.Error()))
		shutdownTracing = func(context.Context) error { return nil }
	}
	defer func() {
		// A FRESH context: ctx is already cancelled by the time this runs, and a
		// cancelled context would abandon the final batch of spans rather than
		// flushing it — losing exactly the spans of the requests served during
		// the drain.
		flushCtx, cancel := context.WithTimeout(context.Background(), otelShutdownTimeout)
		defer cancel()
		if err := shutdownTracing(flushCtx); err != nil {
			logger.Warn("tracing_shutdown_failed",
				slog.String("app_event", "tracing_shutdown_failed"),
				slog.String("exception", err.Error()))
		}
	}()

	// ── The two database pools ───────────────────────────────────────────────
	//
	// SEPARATE pools for reads and writes (ADR-0006). Locally both DSNs point at
	// the same Floci MySQL, but the split is honoured in code so the reader-only
	// path is exercised here rather than for the first time in production.
	//
	// MySQLDSN always appends parseTime=true&loc=UTC, and both are non-negotiable:
	// without parseTime every DATETIME comes back as []byte, and without loc=UTC
	// the driver reads stored values in the PROCESS's local zone — making every
	// timestamp wrong by the offset, silently, and only outside UTC.
	writerDB, err := openPool(cfg.DatabaseWriterURL)
	if err != nil {
		return err
	}
	defer func() { _ = writerDB.Close() }()

	readerDB, err := openPool(cfg.DatabaseReaderURL)
	if err != nil {
		return err
	}
	defer func() { _ = readerDB.Close() }()

	// ── AWS clients ──────────────────────────────────────────────────────────
	//
	// One shared SDK config. AWS_ENDPOINT_URL is applied only when SET: locally it
	// is Floci, and in a deployed environment it must be ABSENT so the SDK
	// resolves the real endpoint itself. That is why config carries it as a
	// *string — an empty-string default would point the SDK at nothing.
	//
	// This block sits BEFORE the cache gateway, and the order is load-bearing:
	// the gateway's metrics port is bound below from cwPublisher, so the
	// publisher must already exist. Built the other way round, the cache had
	// nothing to publish through and got the noop unconditionally — which is
	// exactly the bug selectCacheMetrics now pins.
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(cfg.AWSRegion))
	if err != nil {
		return err
	}

	sqsOptions := []func(*awssqs.Options){}
	cwOptions := []func(*awscw.Options){}
	if cfg.AWSEndpointURL != nil {
		endpoint := *cfg.AWSEndpointURL
		sqsOptions = append(sqsOptions, func(o *awssqs.Options) { o.BaseEndpoint = &endpoint })
		cwOptions = append(cwOptions, func(o *awscw.Options) { o.BaseEndpoint = &endpoint })
	}

	// ── Metrics: THE GATE LIVES HERE ─────────────────────────────────────────
	//
	// METRICS_ENABLED is read in this one place. Every consumer downstream takes
	// an INJECTED publisher, so there is no flag inside the middleware, none
	// inside the ticker, none inside the cache gateway and none in any use case.
	// Off means the dependency is never constructed — not that a constructed
	// publisher is skipped.
	//
	// cwPublisher stays nil when the flag is off, and each consumer below is
	// given the shape that means "no metrics" in ITS OWN vocabulary: a nil
	// interface for the HTTP middleware (which disables the metric at the call
	// site), the noop object for the cache gateway (which calls straight through
	// its port with no nil check), and no ticker goroutine at all.
	var cwPublisher cloudwatch.Publisher
	if cfg.MetricsEnabled {
		cwPublisher = cloudwatch.NewPublisher(awscw.NewFromConfig(awsCfg, cwOptions...))
	}

	// ── The cache gateway ────────────────────────────────────────────────────
	//
	// With CACHE_ENABLED false, NO REDIS CLIENT IS CONSTRUCTED AT ALL — not one
	// that is built and left unused. A service running with the cache off then
	// needs no reachable Redis to boot, which is what makes the flag a real
	// kill switch rather than a request-path branch.
	//
	// The null gateway is a NULL OBJECT, not a nil plus a check: the read and
	// invalidation paths downstream have exactly one shape, and no caller can
	// forget the flag.
	//
	// The client arrives as a FACTORY so "not constructed" is the literal
	// behaviour rather than a claim — SelectGateway is unit-tested by counting
	// how many times this closure runs.
	//
	// THE METRICS PORT IS BOUND HERE, and it is a real binding rather than the
	// noop it used to be. The gateway computes cache_requests_total and
	// cache_operation_duration_ms on EVERY operation; passing the noop
	// unconditionally meant both were computed and discarded even with
	// METRICS_ENABLED=true, leaving two documented series permanently at "no
	// data" while both halves' unit tests stayed green. See selectCacheMetrics.
	gateway, closeCache := cache.SelectGateway(
		cfg.CacheEnabled,
		func() *goredis.Client {
			return cache.NewClient(cfg.RedisHost, cfg.RedisPort, cfg.CacheTimeoutMS)
		},
		selectCacheMetrics(cfg.MetricsEnabled, cwPublisher),
		logger,
	)
	if closeCache != nil {
		defer func() { _ = closeCache() }()
	}

	// ── The outbound Users client ────────────────────────────────────────────
	//
	// One channel for the process. The channel IS a connection pool; building one
	// per call would pay TCP + HTTP/2 setup on every request and leak sockets.
	//
	// A dial failure is logged and swallowed rather than fatal: grpc.NewClient is
	// lazy, so the only errors it returns here are configuration ones, and the
	// six routes that do not resolve a user must keep serving either way.
	var userResolver *grpcusers.InternalIDResolver
	usersClient, err := grpcusers.Dial(cfg.UsersGRPCURL, cfg.GRPCAPIKey)
	if err != nil {
		logger.Error("users_client_unavailable",
			slog.String("app_event", "users_client_unavailable"),
			slog.String("reason", "grpc_dial_failed"),
			slog.String("exception", err.Error()))
	} else {
		defer func() { _ = usersClient.Close() }()
		userResolver = grpcusers.NewInternalIDResolver(usersClient)
	}

	// ── The event publisher ──────────────────────────────────────────────────
	//
	// The NOOP when EVENTS_QUEUE_URL is empty, so a runtime with no queue
	// configured still serves every route and simply emits nothing. A publisher
	// that tried to send to "" would fail once per transition, forever, on a path
	// that is best-effort by contract.
	//
	// It resolves the user ITSELF (through the same Users client) because the
	// pipeline's handler requires an email and Tracking persists none.
	publisher := sqs.NewNoopPublisher()
	switch {
	case cfg.EventsQueueURL == "":
		logger.Warn("events_publishing_disabled",
			slog.String("app_event", "events_publishing_disabled"),
			slog.String("reason", "EVENTS_QUEUE_URL_empty"))
	case usersClient == nil:
		logger.Warn("events_publishing_disabled",
			slog.String("app_event", "events_publishing_disabled"),
			slog.String("reason", "users_client_unavailable"))
	default:
		publisher = sqs.NewPublisher(
			awssqs.NewFromConfig(awsCfg, sqsOptions...),
			cfg.EventsQueueURL,
			usersClient,
			logger,
		)
	}

	// ── Metrics: THE GATE LIVES HERE ─────────────────────────────────────────
	//
	// The publisher itself was constructed ABOVE, before the cache gateway, so
	// the gateway could be bound to it. What remains here are the two consumers
	// that need it in their own shape: the HTTP middleware and the ticker.
	//
	// adapterhttp.MetricPublisher is an INTERFACE, so this must stay a nil
	// INTERFACE rather than a typed nil: a (*publisher)(nil) stored in an
	// interface is non-nil to `== nil` and the middleware would call through it.
	// cwPublisher is declared as the cloudwatch.Publisher INTERFACE and left at
	// its zero value when the flag is off, which is a true nil interface — the
	// assignment below therefore propagates nil-ness correctly.
	var metrics adapterhttp.MetricPublisher
	var tickerDone <-chan struct{}
	if cwPublisher != nil {
		metrics = cwPublisher

		// ctx, the PROCESS LIFETIME context — NEVER a request's. This goroutine
		// outlives every request, and a request context is cancelled the moment
		// its response is sent, which would kill the ticker on the first request
		// and do it silently: cancellation is the loop's normal exit, so nothing
		// would be logged and the dashboards would simply go flat.
		//
		// The READER pool: this query runs forever on a timer and scans the whole
		// live table, so it must not spend the write path's connections on an
		// observation.
		tickerDone = cloudwatch.StartTicker(ctx, cfg.MetricsEnabled, cwPublisher,
			adaptermysql.NewMetricsRepository(readerDB),
			time.Duration(cfg.MetricsIntervalSeconds*float64(time.Second)),
			logger)
	}

	// ── TestMode progression ─────────────────────────────────────────────────
	//
	// ctx, the PROCESS LIFETIME context — NEVER a request's, and this is the one
	// place that decision is made. net/http cancels a request's context the
	// instant its response is written, so a run that inherited one would die at
	// its first tick — and the symptom would be indistinguishable from the
	// ACCEPTED, DOCUMENTED restart limitation ("the tracking froze partway
	// through"). The bug would disguise itself as a known limitation and nobody
	// would investigate it. app.Progression.Start therefore takes no context at
	// all; the only one it can use is the one handed in here.
	//
	// The WRITER pool, and its OWN UpdateStatus: every tick both reads and
	// writes, and the transitions must be the same ones the carrier PUT performs
	// — same guards, same history row, same event, same invalidation. Only the
	// actor differs, and the progression supplies it per call.
	//
	// KNOWN LIMITATION, ACCEPTED: a restart mid-run loses the goroutine and the
	// tracking stays frozen. See app.Progression. Do NOT add a durable scheduler.
	progressionStatuses := adaptermysql.NewStatusRepository(writerDB)
	progression := app.NewProgression(
		ctx,
		progressionStatuses,
		app.NewUpdateStatus(
			progressionStatuses,
			notify.NewStatusEventPublisher(publisher),
			notify.NewTrackingCacheInvalidator(gateway, logger),
			nil, // the production clock: UTC, truncated to the second
		),
		app.DefaultProgressionInterval,
		logger,
		// The WORKFLOW tracer: the Python opens this span through workflow_span,
		// and one query in OpenObserve must mean the same thing in both runtimes.
		tracing.Tracer(tracing.TracerWorkflow),
	)

	// ── The router ───────────────────────────────────────────────────────────
	router := adapterhttp.NewAppRouter(adapterhttp.AppRouterOptions{
		WriterDB:          writerDB,
		ReaderDB:          readerDB,
		Gateway:           gateway,
		CacheEnabled:      cfg.CacheEnabled,
		E2ETestingEnabled: cfg.E2ETestingEnabled,
		CarrierAPIKey:     cfg.TrackingCarrierAPIKey,
		InternalAPIKey:    cfg.GRPCAPIKey,
		// A typed-nil trap of the same shape as the metrics one: app.UserResolver
		// is an interface, so a nil *InternalIDResolver assigned to it would be
		// non-nil. Left as the zero interface when there is no client.
		Users:     userResolverOrNil(userResolver),
		Publisher: publisher,
		// The real TestMode progression, constructed above on the PROCESS
		// context. The handler invokes it only after the response is written,
		// and therefore after the creating transaction has committed.
		Hook:    adapterhttp.NewTestModeProgressionHook(progression),
		Metrics: metrics,
		Logger:  logger,
	})

	srv := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           router,
		ReadHeaderTimeout: serverReadHeaderTimeout,
	}

	serverErr := make(chan error, 1)
	go func() {
		logger.Info("http server starting",
			slog.String("app_event", "http_server_starting"),
			slog.String("addr", srv.Addr))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
			return
		}
		serverErr <- nil
	}()

	// stopTicker waits for the metrics goroutine to actually finish, so the
	// process does not exit with a publish in flight. ctx's cancellation is what
	// ends the loop; this only joins it.
	stopTicker := sync.OnceFunc(func() {
		if tickerDone == nil {
			return
		}
		select {
		case <-tickerDone:
		case <-time.After(shutdownGracePeriod):
			logger.Warn("metrics_ticker_shutdown_timeout",
				slog.String("app_event", "metrics_ticker_shutdown_timeout"))
		}
	})

	// drainProgressions joins every in-flight TestMode run. ctx's cancellation is
	// what ends them; this only waits, and LOGS if the budget runs out — the
	// process must not exit leaving goroutines mid-flight without at least
	// saying so.
	//
	// A FRESH context: ctx is already cancelled by the time this runs, so passing
	// it would make Wait report an incomplete drain immediately, every time,
	// whatever actually happened.
	drainProgressions := sync.OnceFunc(func() {
		drainCtx, cancel := context.WithTimeout(context.Background(), shutdownGracePeriod)
		defer cancel()
		progression.Wait(drainCtx)
	})

	select {
	case err := <-serverErr:
		stop()
		stopTicker()
		drainProgressions()
		return err

	case <-ctx.Done():
		logger.Info("shutdown signal received, draining connections",
			slog.String("app_event", "http_server_draining"))

		// A FRESH context: ctx is already cancelled, so passing it to Shutdown
		// would abort in-flight requests immediately instead of draining them.
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGracePeriod)
		defer cancel()

		if err := srv.Shutdown(shutdownCtx); err != nil {
			stopTicker()
			drainProgressions()
			return err
		}
		stopTicker()
		drainProgressions()
		logger.Info("http server stopped cleanly",
			slog.String("app_event", "http_server_stopped"))
		return nil
	}
}

// openPool converts a SQLAlchemy DSN and opens an INSTRUMENTED pool.
//
// otelsql.Open does NOT dial — like sql.Open it only validates the DSN — so a
// database that is still starting does not prevent this process from coming up
// and serving its liveness probe. That is deliberate: the health check answers
// "is this process serving HTTP", and folding a connectivity check into startup
// would make a transient database blip cycle otherwise-healthy tasks.
//
// # WHY THE otelsql WRAPPING LIVES HERE
//
// Go has no opentelemetry-instrument, so the SQL spans Python got for free must
// be wired by hand. This is the ONE place a pool is opened, and every repository
// takes a plain *sql.DB — which otelsql.Open returns — so wrapping here
// instruments all four repositories at once, changes no adapter, and leaves no
// second, uninstrumented way to open a pool.
//
// What it buys: a workflow span that spends 300ms shows WHICH query spent it,
// instead of an opaque gap. The DB spans are CLIENT spans and hang off whatever
// span is active on the context passed to ExecContext/QueryContext — which is
// why every repository method taking a ctx (they all do) matters.
//
// THE QUERY TEXT IS SUPPRESSED, and that is the load-bearing option here.
//
// otelsql records db.query.text BY DEFAULT — verified, not assumed: an
// instrumented UPDATE emitted
//
//	db.query.text = "UPDATE trackings SET shipping_address='221B Baker Street' ..."
//
// with no options set. This service's write paths carry exactly that column, and
// shipping_address is named PII in the repo's logging rules; a span attribute
// fans out to the collector and to OpenObserve just as a log line does, so the
// same prohibition applies. DisableQuery is therefore ON.
//
// What is lost is nothing that was needed: the span name and the SQL method
// still identify WHICH call was slow, which is the question these spans exist to
// answer. Turning this off to "see the query" would leak a customer's address
// into observability storage.
func openPool(sqlAlchemyDSN string) (*sql.DB, error) {
	dsn, err := config.MySQLDSN(sqlAlchemyDSN)
	if err != nil {
		return nil, err
	}
	// No tracer provider is passed: otelsql falls back to the global one, which
	// SetupTracing installed above. Passing an option whose value came out empty
	// LOSES to auto-detection with no error at all — the same trap the OTLP
	// exporter's configuration avoids by reading its environment variables.
	return otelsql.Open("mysql", dsn, poolTracingOptions()...)
}

// poolTracingOptions is the ONE declaration of how database spans are shaped.
//
// Extracted so the PII guard (TestDatabaseSpansCarryNoQueryText) and the
// ErrSkip guard (TestDatabaseSpansDoNotRecordErrSkip) can assert against the
// very options production uses. Inlined, those tests had to restate them, and a
// restated option set is one that can silently stop matching the real one —
// leaving the leak guarded only in the test's own copy.
//
// Both defaults here work AGAINST us, in opposite directions: otelsql records
// too much (the query text, which is PII) and treats too much as an error
// (driver.ErrSkip, which is not one).
func poolTracingOptions() []otelsql.Option {
	return []otelsql.Option{
		// The semconv system attribute, so a span is attributable to MySQL
		// rather than to "some database".
		otelsql.WithAttributes(semconv.DBSystemNameMySQL),
		otelsql.WithSpanOptions(otelsql.SpanOptions{
			// THE PII GUARD. See the block above openPool: otelsql records
			// db.query.text BY DEFAULT, and this service's write statements
			// carry shipping_address.
			DisableQuery: true,

			// driver.ErrSkip IS NOT AN ERROR. It is a database/sql SENTINEL:
			// a driver returns it to say "I do not implement this optional
			// fast path" (CheckNamedValue, ExecerContext, QueryerContext…),
			// and database/sql then falls back to the generic path and the
			// call succeeds. It is internal control flow, and it happens on
			// the ORDINARY path here — go-sql-driver/mysql returns ErrSkip
			// from Exec and query whenever a statement carries arguments and
			// InterpolateParams is off, which is the default and therefore
			// every parameterized statement this service runs. otelsql's own
			// conn.go returns it as well, from each optional interface the
			// wrapped driver lacks.
			//
			// Left at its default, otelsql calls span.RecordError and
			// SetStatus(codes.Error) on it, and the traces fill with
			// exception events reading
			//
			//	driver: skip fast-path; continue as if unimplemented
			//
			// for something that never went wrong. Two costs, and the first
			// is the expensive one: it TRAINS whoever reads the waterfall to
			// ignore errors on database spans, which is exactly the habit
			// that scrolls past a real one. And the error status makes spans
			// render as failed when the query succeeded.
			//
			// Suppressing it buys a trace where an error on a DB span means a
			// database problem. Do NOT remove this thinking you are restoring
			// error visibility: genuine driver errors still take
			// recordSpanError's default branch and are recorded exactly as
			// before — only the ErrSkip sentinel is filtered.
			DisableErrSkip: true,
		}),
		// The METRICS half of the same non-event: without it, ErrSkip is
		// stamped as error.type="database/sql/driver.ErrSkip" on the
		// db.client.operation.duration measurement — verified against v0.43.0,
		// not assumed — so the dashboards count a fast-path fallback as a
		// failed database call.
		// Set TOGETHER with DisableErrSkip on purpose — suppressing it in
		// spans while metrics still counted it would leave a dashboard and a
		// trace disagreeing about the same non-event, which is a worse
		// diagnostic position than either alone.
		otelsql.WithDisableSkipErrMeasurement(true),
	}
}

// userResolverOrNil keeps a typed nil out of the interface field.
//
// A (*InternalIDResolver)(nil) assigned to an interface is NOT equal to nil, so
// every downstream nil check would pass and the first creation would dereference
// it. Returning the zero interface is the only way to say "there is none".
func userResolverOrNil(r *grpcusers.InternalIDResolver) app.UserResolver {
	if r == nil {
		return nil
	}
	return r
}
