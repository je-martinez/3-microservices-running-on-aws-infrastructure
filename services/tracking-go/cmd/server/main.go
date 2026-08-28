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

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awscw "github.com/aws/aws-sdk-go-v2/service/cloudwatch"
	awssqs "github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/gin-gonic/gin"
	_ "github.com/go-sql-driver/mysql"
	goredis "github.com/redis/go-redis/v9"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers"
	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
	adaptermysql "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/config"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
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
	logger := logging.Install(deploymentEnvironment)

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
	gateway, closeCache := cache.SelectGateway(
		cfg.CacheEnabled,
		func() *goredis.Client {
			return cache.NewClient(cfg.RedisHost, cfg.RedisPort, cfg.CacheTimeoutMS)
		},
		cache.NewNoopMetrics(),
		logger,
	)
	if closeCache != nil {
		defer func() { _ = closeCache() }()
	}

	// ── AWS clients ──────────────────────────────────────────────────────────
	//
	// One shared SDK config. AWS_ENDPOINT_URL is applied only when SET: locally it
	// is Floci, and in a deployed environment it must be ABSENT so the SDK
	// resolves the real endpoint itself. That is why config carries it as a
	// *string — an empty-string default would point the SDK at nothing.
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
	// METRICS_ENABLED is read in this one place. The middleware takes an INJECTED
	// publisher and a nil one already disables the metric at the call site, so
	// there is no flag inside the middleware, none inside the ticker, and none in
	// any use case. Off means the dependency is never constructed and the
	// goroutine never starts — not that a constructed publisher is skipped.
	//
	// adapterhttp.MetricPublisher is an INTERFACE, so this must stay a nil
	// INTERFACE rather than a typed nil: a (*publisher)(nil) stored in an
	// interface is non-nil to `== nil` and the middleware would call through it.
	var metrics adapterhttp.MetricPublisher
	var tickerDone <-chan struct{}
	if cfg.MetricsEnabled {
		cwPublisher := cloudwatch.NewPublisher(awscw.NewFromConfig(awsCfg, cwOptions...))
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
		// Wave 2.5 supplies the real progression; until then creation works and
		// nothing advances. A NAMED no-op, so the wiring reads as "deliberately
		// does nothing" rather than an oversight.
		Hook:    adapterhttp.NoopProgression{},
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

	select {
	case err := <-serverErr:
		stop()
		stopTicker()
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
			return err
		}
		stopTicker()
		logger.Info("http server stopped cleanly",
			slog.String("app_event", "http_server_stopped"))
		return nil
	}
}

// openPool converts a SQLAlchemy DSN and opens the pool.
//
// sql.Open does NOT dial — it only validates the DSN — so a database that is
// still starting does not prevent this process from coming up and serving its
// liveness probe. That is deliberate: the health check answers "is this process
// serving HTTP", and folding a connectivity check into startup would make a
// transient database blip cycle otherwise-healthy tasks.
func openPool(sqlAlchemyDSN string) (*sql.DB, error) {
	dsn, err := config.MySQLDSN(sqlAlchemyDSN)
	if err != nil {
		return nil, err
	}
	return sql.Open("mysql", dsn)
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
