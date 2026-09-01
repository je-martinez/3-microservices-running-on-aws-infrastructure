package http

import (
	"database/sql"
	"log/slog"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"

	adaptermysql "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/notify"
	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// AppRouterOptions is everything the composed router needs from OUTSIDE the HTTP
// layer.
//
// WHY: All configuration decisions and opened dependencies arrive from the
// composition root, keeping the complete route table testable without external
// services.
type AppRouterOptions struct {
	// WriterDB and ReaderDB are SEPARATE fields even where both point at the
	// same local server (ADR-0006). Honouring the split in code is what makes
	// local and deployed behave identically instead of the reader-only path
	// being exercised for the first time in production.
	WriterDB *sql.DB
	ReaderDB *sql.DB

	// Gateway is cache.NewNullGateway() when CACHE_ENABLED is false. A NULL
	// OBJECT, not a nil plus a branch: the read and invalidation paths then have
	// exactly one shape, and no caller can forget to check the flag.
	Gateway cache.Gateway
	// CacheEnabled is still passed because the reads stamp X-Cache: BYPASS from
	// it, which is a different observable fact from "the lookup missed".
	CacheEnabled bool

	// E2ETestingEnabled decides whether the e2e-cleanup route EXISTS. See
	// RegisterE2ECleanup.
	E2ETestingEnabled bool

	// The two keys are two TRUST DOMAINS and never interchangeable:
	// CarrierAPIKey is TRACKING_CARRIER_API_KEY, handed to a third-party
	// carrier; InternalAPIKey is GRPC_API_KEY, shared only with Users and
	// Orders. Swapping them would let a carrier mass-delete a user's history.
	CarrierAPIKey  string
	InternalAPIKey string

	// Users resolves the caller's internal usr_ id for creation. May be nil in a
	// wiring test; creation is then the only route that cannot serve.
	Users app.UserResolver

	// Publisher and the progression hook are optional in exactly the same sense:
	// nil is a legal, documented, degraded wiring rather than a crash.
	Publisher sqs.Publisher
	Hook      ProgressionHook

	// Metrics is nil when METRICS_ENABLED is false. A nil publisher DISABLES the
	// metric at the call site, which is why the flag is gated in the composition
	// root and nowhere else.
	Metrics MetricPublisher

	Logger *slog.Logger
}

// NewAppRouter builds the fully-wired Gin engine: every middleware, every route.
// CONTRACT: Do NOT move composition into main.go or reorder Recovery -> otelgin
// -> LogContext -> flags. Moving it hides dropped seams from unit tests;
// inverted Recovery drops panicked connections without a 500, while LogContext
// outside otelgin emits request lines without trace_id/span_id. Keep GinFilter
// installed to suppress health spans.
// See [[logging-context]]
func NewAppRouter(opts AppRouterOptions) *gin.Engine {
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}

	// The gateway is normalized ONCE, here, so every consumer below receives a
	// real object. main always supplies one (SelectGateway returns the null
	// gateway when CACHE_ENABLED is false), but a hand-built options struct in a
	// test may not — and the identity cache dereferences it directly, unlike the
	// reads handler which null-objects it internally.
	gateway := opts.Gateway
	if gateway == nil {
		gateway = cache.NewNullGateway()
	}

	router := gin.New()
	router.Use(
		gin.Recovery(),
		// CONTRACT: Do NOT remove otelgin or pass explicit provider globals.
		// Missing middleware splits one request into unrelated traces; explicit
		// globals bypass otelgin's configured autodetection.
		// See [[logging-context]]
		otelgin.Middleware(logging.ServiceName, otelgin.WithFilter(tracing.GinFilter)),
		LogContextMiddleware(log, opts.Metrics),
		E2ESourceMiddleware(opts.E2ETestingEnabled),
		// Same flag, same reason: the run id becomes half of a mass-delete
		// predicate, so it is resolved here rather than by any handler.
		RunIDMiddleware(opts.E2ETestingEnabled),
		TestModeMiddleware(),
	)

	// Gin defaults this to FALSE, which answers 404 for a path that exists under
	// a different method. The Python answers 405 — notably for the unmounted
	// e2e-cleanup route, whose path GET /v1/trackings/:order_id still matches —
	// so leaving the default would be a silent behavioural drift on a surface the
	// equivalence gate compares.
	router.HandleMethodNotAllowed = true

	RegisterHealth(router)

	// Creation. Writes go to the WRITER pool.
	RegisterInitTracking(router, NewInitTrackingHandler(
		app.NewCreateTracking(
			opts.Users,
			adaptermysql.NewTrackingRepository(opts.WriterDB),
			nil, // the production clock: UTC, truncated to the second
		),
		opts.Hook,
		log,
		tracing.Tracer(tracing.TracerWorkflow),
	))

	// CONTRACT: Do NOT apply StampResolvedUserID globally or remove it from the
	// read group. Global stamping sends carrier, delete, and health traffic to
	// Users; missing stamping makes every response-cache lookup unkeyable and a
	// permanent MISS. Creation resolves identity as a required operation itself.
	// See [[tracking-service-design]]
	reads := router.Group("", StampResolvedUserID(
		// A nil app.UserResolver arrives as a nil internalIDResolver, which the
		// middleware treats as "nothing to resolve with" and no-ops.
		opts.Users,
		// THROUGH THE IDENTITY CACHE, never straight to gRPC: that cache exists
		// so a response-cache hit does not still pay a gRPC round trip. Built
		// over the SAME gateway, so CACHE_ENABLED=false makes it a null object
		// and every request falls through to the direct call.
		cache.NewIdentityCache(gateway),
		log,
	))
	WireReads(reads, opts.ReaderDB, gateway, opts.CacheEnabled, log)

	// The carrier webhook. Its own external key, declared at the group level.
	RegisterCarrierRoutes(router, NewCarrierHandler(
		app.NewUpdateStatus(
			adaptermysql.NewStatusRepository(opts.WriterDB),
			notify.NewStatusEventPublisher(opts.Publisher),
			notify.NewTrackingCacheInvalidator(gateway, log),
			nil,
		),
		log,
		tracing.Tracer(tracing.TracerWorkflow),
	), opts.CarrierAPIKey)

	// The account-deletion cascade's leg. Internal key, applied by the seam.
	softDeletes := adaptermysql.NewSoftDeleteRepository(opts.WriterDB)
	RegisterInternalDelete(router, NewInternalDeleteHandler(
		app.NewDeleteByUser(softDeletes, cache.NewUserInvalidator(gateway, log), nil),
		log,
		tracing.Tracer(tracing.TracerWorkflow),
	), opts.InternalAPIKey)

	// The E2E teardown, registered ONLY when the flag is on. See
	// RegisterE2ECleanup for why the condition is here and not inside it.
	if opts.E2ETestingEnabled {
		// WARNING, not INFO, and at startup: in a deployed runtime this line
		// means a mass soft-delete surface is live and somebody should see it.
		// Same severity and same app_event the Python emits.
		log.Warn("e2e_routes_enabled",
			slog.String("app_event", "e2e_routes_enabled"),
			slog.String("reason", "E2E_TESTING_ENABLED"))

		RegisterE2ECleanup(router, NewE2ECleanupHandler(
			app.NewE2ECleanup(softDeletes, nil), log,
			tracing.Tracer(tracing.TracerWorkflow)))
	}

	return router
}
