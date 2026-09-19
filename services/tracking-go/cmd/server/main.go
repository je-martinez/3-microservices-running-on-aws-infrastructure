// Command server runs the Tracking HTTP service. Dependencies are wired by hand
// here: no container, no generation, no reflection.
//
// CONTRACT: Keep this file to what cannot be tested in-process — config, sockets,
// the ticker, shutdown. Routes and middleware stay in adapterhttp.NewAppRouter,
// which a test can import; main() cannot, so anything decided here is observable
// only by starting a process.
//
// CONTRACT: CACHE_ENABLED, METRICS_ENABLED and EVENTS_TOPIC_ARN are read here
// once and turned into a dependency. No use case or middleware branches on a
// flag. See [[screaming-architecture]]
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
	awssns "github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/gin-gonic/gin"
	_ "github.com/go-sql-driver/mysql"
	goredis "github.com/redis/go-redis/v9"
	semconv "go.opentelemetry.io/otel/semconv/v1.38.0"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers"
	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
	adaptermysql "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/notify"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/ordershttp"
	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/outbox"
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
// WHY: One long function on purpose — its ORDER is what a reader checks, and
// helpers scatter each resource's shutdown away from the line that opened it.
//
//nolint:funlen,gocyclo // see above: the length IS the readable form here.
func run() error {
	// CONTRACT: Structured JSON to stdout, before anything can log — OpenObserve
	// ingests via the fluentd driver and cannot query a plain-text line.
	// DEPLOYMENT_ENVIRONMENT comes off the raw environment, not the validated
	// Config: logging must not depend on a fully-valid environment.
	// See [[logging-context]]
	deploymentEnvironment := os.Getenv("DEPLOYMENT_ENVIRONMENT")
	if deploymentEnvironment == "" {
		deploymentEnvironment = "local"
	}
	// CONTRACT: installProcessLogger is the only constructor that builds the
	// complete logger. A logger built in internal/platform/logging carries the
	// correlation fields but never trace_id/span_id, and nothing else joins the
	// two transports. Calling it before SetupTracing is safe and intended:
	// TraceHandler reads the ambient span at Handle time, so startup lines omit
	// the trace fields rather than zeroing them. See [[logging-context]]
	logger := installProcessLogger(os.Stdout, deploymentEnvironment)

	// CONTRACT: Call this BEFORE the pools open. ParseDSN copies the package-level
	// logger into each connection's Config, so a pool opened first keeps
	// go-sql-driver's plain-stderr logger for life while this call looks like it
	// fixed things — and those lines land in the collector as `unclassified`.
	// See [[logging-context]]
	installDriverLogging(logger)

	// A loud failure on a missing required variable. Exactly four are required;
	// every optional one has fallen back to its default by the time Load returns.
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	if ginMode := os.Getenv("GIN_MODE"); ginMode != "" {
		gin.SetMode(ginMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	// CONTRACT: Every background goroutine derives from this process-lifetime
	// context, never a request's — a request context is cancelled the instant its
	// response is sent, killing the metrics ticker on the first request it was
	// started from. NotifyContext handles the SIGTERM ECS sends when draining.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// ── OpenTelemetry ────────────────────────────────────────────────────────
	//
	// CONTRACT: Do NOT pass endpoint, protocol or headers here — the SDK reads
	// the standard OTEL_EXPORTER_OTLP_* variables, and an option whose value came
	// out empty loses to auto-detection with no error at all. A setup failure is
	// logged and swallowed: a down collector must not stop the service serving.
	// See [[ADR-0019-distributed-tracing-opentelemetry]]
	shutdownTracing, err := tracing.SetupTracing(ctx)
	if err != nil {
		logger.Warn("tracing_setup_failed",
			slog.String("app_event", "tracing_setup_failed"),
			slog.String("reason", "otlp_exporter_unavailable"),
			slog.String("exception", err.Error()))
		shutdownTracing = func(context.Context) error { return nil }
	}
	defer func() {
		// CONTRACT: A FRESH context — ctx is already cancelled here, and a
		// cancelled one abandons the final batch, losing exactly the spans of
		// the requests served during the drain.
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
	// CONTRACT: Keep the reader/writer split in code even where both DSNs point
	// at one local MySQL, so the reader-only path is not first exercised in
	// production. MySQLDSN always appends parseTime=true&loc=UTC: without the
	// first, DATETIME arrives as []byte; without the second the driver reads
	// stored values in the process zone, silently wrong by the offset outside
	// UTC. See [[ADR-0006-read-write-replicas]]
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
	// CONTRACT: Apply AWS_ENDPOINT_URL only when SET — deployed it must be absent
	// so the SDK resolves the real endpoint, which is why config carries a
	// *string. Keep this block BEFORE the cache gateway: the gateway binds its
	// metrics port from cwPublisher, and the other order hands the cache the noop
	// unconditionally. See [[local-dev]]
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(cfg.AWSRegion))
	if err != nil {
		return err
	}

	snsOptions := []func(*awssns.Options){}
	cwOptions := []func(*awscw.Options){}
	if cfg.AWSEndpointURL != nil {
		endpoint := *cfg.AWSEndpointURL
		snsOptions = append(snsOptions, func(o *awssns.Options) { o.BaseEndpoint = &endpoint })
		cwOptions = append(cwOptions, func(o *awscw.Options) { o.BaseEndpoint = &endpoint })
	}

	// ── Metrics: THE GATE LIVES HERE ─────────────────────────────────────────
	//
	// CONTRACT: METRICS_ENABLED is read here and nowhere else — no flag inside a
	// middleware, ticker, gateway or use case. Off means the dependency is never
	// constructed: a nil interface for the middleware, the noop for the cache
	// gateway, no ticker goroutine at all. See [[logging-context]]
	// CONTRACT: Wrap ONCE here so no consumer gets the blocking publisher. The
	// middleware and the cache gateway publish on the request goroutine, and Floci
	// serializes PutMetricData: wired synchronously, a read answered in ~490ms.
	//
	// CONTRACT: ctx, the process-lifetime context — never a request's, which is
	// cancelled when its response is written. See [[logging-context]]
	var cwPublisher cloudwatch.Publisher
	var metricsFlusher *cloudwatch.AsyncPublisher
	if cfg.MetricsEnabled {
		metricsFlusher = cloudwatch.NewAsyncPublisher(
			ctx,
			cloudwatch.NewPublisher(awscw.NewFromConfig(awsCfg, cwOptions...)),
			cloudwatch.AsyncOptions{Log: logger},
		)
		cwPublisher = metricsFlusher
	}

	// ── The cache gateway ────────────────────────────────────────────────────
	//
	// CONTRACT: With CACHE_ENABLED false no Redis client is constructed, so the
	// service boots with no reachable Redis. The client arrives as a factory so
	// that is literal behaviour SelectGateway can count, and the null gateway is
	// a null object so no caller downstream can forget the flag.
	//
	// CONTRACT: Bind the real metrics port here. Passing the noop leaves
	// cache_requests_total and cache_operation_duration_ms at "no data" even
	// with METRICS_ENABLED=true, while both halves' unit tests stay green.
	// See [[logging-context]]
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
	// One channel per process — the channel is the pool, so one per call would
	// pay TCP + HTTP/2 setup per request and leak sockets. A dial failure is
	// logged, not fatal: grpc.NewClient is lazy, so it only returns config
	// errors here and the six routes that resolve no user must keep serving.
	var userResolver *grpcusers.InternalIDResolver
	usersClient, err := grpcusers.Dial(cfg.UsersGRPCURL, cfg.InternalAPIKey)
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
	// The noop when EVENTS_TOPIC_ARN is empty, so a runtime with no topic serves
	// every route and emits nothing; publishing to "" would fail once per
	// transition forever on a best-effort path. It resolves the user itself
	// because the pipeline's handler requires an email Tracking never persists.

	// A sqs.FailablePublisher: the router takes the void form off it, the outbox
	// bridge the error-returning one.
	publisher := sqs.NewNoopPublisher()
	switch {
	case cfg.EventsTopicARN == "":
		logger.Warn("events_publishing_disabled",
			slog.String("app_event", "events_publishing_disabled"),
			slog.String("reason", "EVENTS_TOPIC_ARN_empty"))
	case usersClient == nil:
		logger.Warn("events_publishing_disabled",
			slog.String("app_event", "events_publishing_disabled"),
			slog.String("reason", "users_client_unavailable"))
	default:
		publisher = sqs.NewPublisher(
			awssns.NewFromConfig(awsCfg, snsOptions...),
			cfg.EventsTopicARN,
			usersClient,
			logger,
		)
	}

	// ── The cross-service cache invalidation ─────────────────────────────────
	//
	// CONTRACT: The INTERNAL key, InternalAPIKey — never TrackingCarrierAPIKey. The
	// two share a header name and nothing else, and handing an outside vendor's
	// secret to an internal surface reaches route 6, a mass soft-delete.
	// See [[two-api-keys-two-trust-domains]]
	//
	// An empty ORDERS_BASE_URL leaves it inert rather than failing the boot: a
	// status change then clears only this service's keys, which is a stale read
	// and not a lost delivery.
	if cfg.OrdersBaseURL == "" {
		logger.Warn("orders_cache_invalidation_disabled",
			slog.String("app_event", "orders_cache_invalidation_disabled"),
			slog.String("reason", "ORDERS_BASE_URL_empty"))
	}
	orderCacheInvalidator := ordershttp.NewCacheInvalidator(
		cfg.OrdersBaseURL, cfg.InternalAPIKey, logger)

	// ── Metrics consumers: middleware and ticker ─────────────────────────────
	//
	// CONTRACT: Keep this a nil INTERFACE, never a typed nil. A (*publisher)(nil)
	// stored in an interface is non-nil to `== nil`, and the middleware would
	// call through it. cwPublisher is the cloudwatch.Publisher interface left at
	// its zero value, so the assignment propagates nil-ness. See [[logging-context]]
	var metrics adapterhttp.MetricPublisher
	var tickerDone <-chan struct{}
	if cwPublisher != nil {
		metrics = cwPublisher

		// CONTRACT: ctx, the process-lifetime context — never a request's. A
		// request context is cancelled when its response is sent, killing the
		// ticker silently (cancellation is the loop's normal exit, so nothing
		// logs and the dashboards just go flat). Reader pool: this scans the
		// whole live table forever and must not spend write connections.
		tickerDone = cloudwatch.StartTicker(ctx, cfg.MetricsEnabled, cwPublisher,
			adaptermysql.NewMetricsRepository(readerDB),
			time.Duration(cfg.MetricsIntervalSeconds*float64(time.Second)),
			logger)
	}

	// ── The transactional outbox ─────────────────────────────────────────────
	//
	// CONTRACT: The outbox and the INLINE publisher are mutually exclusive. Both
	// wired publishes every transition twice and the customer gets two emails, so
	// the inline publisher is nil below. The WRITER pool: the claim locks rows and
	// the cycle deletes. See [[cqrs]]
	outboxWriter := adaptermysql.NewOutboxWriter(writerDB)

	// It runs IN-PROCESS in every task rather than as a separate binary, so every
	// instance polls — which is why the claim uses FOR UPDATE SKIP LOCKED.
	//
	// CONTRACT: ctx, the PROCESS LIFETIME context — never a request's. Cancellation
	// is this loop's NORMAL exit, so an inherited request context stops the poller
	// SILENTLY while transitions keep recording messages nothing drains.
	// See [[cqrs]]
	outboxPollerDone := outbox.NewPoller(
		writerDB,
		notify.NewOutboxSNSPublisher(publisher),
		outbox.Options{Log: logger},
	).Start(ctx)

	// ── TestMode progression ─────────────────────────────────────────────────
	//
	// CONTRACT: Pass ctx, the PROCESS LIFETIME context — never a request's.
	// net/http cancels a request context the instant its response is written, so
	// an inherited one dies at the first tick and looks exactly like the accepted
	// restart limitation ("froze partway through"), which nobody investigates.
	// Start takes no context of its own precisely to keep this the only choice.
	//
	// CONTRACT: Do NOT add a durable scheduler — a restart mid-run loses the
	// goroutine and the tracking stays frozen, and that is accepted.
	// See [[testmode-in-process-no-durable-scheduler]]
	progressionStatuses := adaptermysql.NewStatusRepository(writerDB,
		adaptermysql.WithOutbox(outboxWriter))
	progression := app.NewProgression(
		ctx,
		progressionStatuses,
		app.NewUpdateStatus(
			progressionStatuses,
			// Nil, because the outbox above publishes this transition. The two
			// paths must never both be wired.
			nil,
			notify.NewTrackingCacheInvalidator(gateway, logger),
			// The SAME invalidator the carrier path uses. A TestMode transition
			// makes Orders' cached body stale in exactly the same way, so the
			// two must not disagree about what a transition invalidates.
			orderCacheInvalidator,
			nil, // the production clock: UTC, truncated to the second
		),
		// From config, not the constant: the E2E suite pays this interval four
		// times per delivery spec, three specs deep. NewProgression falls back to
		// DefaultProgressionInterval on a non-positive value.
		time.Duration(cfg.ProgressionIntervalSeconds*float64(time.Second)),
		logger,
		// CONTRACT: The WORKFLOW tracer — one OpenObserve query must resolve
		// this span the same way across every service that opens it.
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
		InternalAPIKey:    cfg.InternalAPIKey,
		// A typed-nil trap of the same shape as the metrics one: app.UserResolver
		// is an interface, so a nil *InternalIDResolver assigned to it would be
		// non-nil. Left as the zero interface when there is no client.
		Users:     userResolverOrNil(userResolver),
		Publisher: publisher,
		// CONTRACT: Set this and the router leaves the INLINE publisher nil. Both
		// wired means two publishes per transition and two customer emails.
		Outbox: outboxWriter,
		// The cross-service sweep, on the carrier webhook's write path.
		OrderCacheInvalidator: orderCacheInvalidator,
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

	// flushMetrics drains the buffered data and joins the flusher.
	//
	// CONTRACT: Call it AFTER stopTicker and srv.Shutdown — both publish, and a
	// publish arriving after the queue closes panics on a send to a closed
	// channel. Close bounds its own drain. See [[logging-context]]
	flushMetrics := sync.OnceFunc(func() {
		if metricsFlusher == nil {
			return
		}
		metricsFlusher.Close()
	})

	// stopOutboxPoller joins the poller's goroutine, so the process does not exit
	// mid-cycle with a claim transaction open — rows locked by a dead connection
	// stay locked until InnoDB rolls it back, and every other task's poller skips
	// them meanwhile. ctx's cancellation is what ends the loop; this only joins it.
	stopOutboxPoller := sync.OnceFunc(func() {
		select {
		case <-outboxPollerDone:
		case <-time.After(shutdownGracePeriod):
			logger.Warn("outbox_poller_shutdown_timeout",
				slog.String("app_event", "outbox_poller_shutdown_timeout"))
		}
	})

	// drainProgressions joins every in-flight TestMode run and logs if the budget
	// runs out. It takes a FRESH context: ctx is already cancelled here, so
	// passing it makes Wait report an incomplete drain every time regardless.
	drainProgressions := sync.OnceFunc(func() {
		drainCtx, cancel := context.WithTimeout(context.Background(), shutdownGracePeriod)
		defer cancel()
		progression.Wait(drainCtx)
	})

	select {
	case err := <-serverErr:
		stop()
		stopTicker()
		stopOutboxPoller()
		drainProgressions()
		flushMetrics()
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
			stopOutboxPoller()
			drainProgressions()
			flushMetrics()
			return err
		}
		stopTicker()
		stopOutboxPoller()
		drainProgressions()
		flushMetrics()
		logger.Info("http server stopped cleanly",
			slog.String("app_event", "http_server_stopped"))
		return nil
	}
}

// openPool converts a SQLAlchemy DSN and opens an INSTRUMENTED pool.
//
// CONTRACT: This is the ONE place a pool is opened, so wrapping here instruments
// every repository at once and leaves no uninstrumented way to open one. Do NOT
// add a connectivity check: otelsql.Open only validates the DSN, so a database
// still starting does not stop this process serving its liveness probe.
//
// CONTRACT: DisableQuery stays ON. otelsql records db.query.text by default, and
// this service's writes carry shipping_address — a span attribute reaches
// OpenObserve exactly as a log line does, so the PII prohibition applies. The
// span name and SQL method still identify which call was slow.
// See [[logging-context]]
func openPool(sqlAlchemyDSN string) (*sql.DB, error) {
	dsn, err := config.MySQLDSN(sqlAlchemyDSN)
	if err != nil {
		return nil, err
	}
	// CONTRACT: Do NOT pass a tracer provider — otelsql falls back to the global
	// one SetupTracing installed, and an option whose value came out empty loses
	// to auto-detection with no error at all.
	return otelsql.Open("mysql", dsn, poolTracingOptions()...)
}

// poolTracingOptions is the ONE declaration of how database spans are shaped.
//
// CONTRACT: Keep this extracted, so the PII and ErrSkip guards assert against
// the options production uses. Inlined, a test restates them and can silently
// stop matching, leaving the leak guarded only in the test's own copy.
// See [[logging-context]]
func poolTracingOptions() []otelsql.Option {
	return []otelsql.Option{
		// The semconv system attribute, so a span names MySQL specifically.
		otelsql.WithAttributes(semconv.DBSystemNameMySQL),
		otelsql.WithSpanOptions(otelsql.SpanOptions{
			// CONTRACT: The PII guard — otelsql records db.query.text by
			// default and the write statements carry shipping_address.
			DisableQuery: true,

			// CONTRACT: Do NOT remove this thinking it restores error
			// visibility. driver.ErrSkip is a database/sql sentinel meaning
			// "optional fast path unimplemented" — go-sql-driver returns it
			// for every parameterized statement here. Left recorded, every
			// database span carries a false exception, which trains readers
			// to ignore errors on database spans. Genuine driver errors are
			// still recorded; only the sentinel is filtered.
			// See [[logging-context]]
			DisableErrSkip: true,
		}),
		// CONTRACT: Set this TOGETHER with DisableErrSkip. Without it ErrSkip
		// is stamped as error.type on db.client.operation.duration and the
		// dashboards count a fast-path fallback as a failed database call,
		// leaving trace and dashboard disagreeing about the same non-event.
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
