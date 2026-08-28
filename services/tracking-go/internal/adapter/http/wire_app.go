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
// Every field is a dependency the composition root DECIDES and this function only
// USES. In particular the two pools arrive already opened, the gateway arrives
// already chosen (real or null), and E2ETestingEnabled arrives already read — so
// this function contains no config lookup, no sql.Open and no Redis dial, and a
// test can therefore construct the complete route table without a database, a
// Redis or an AWS endpoint.
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
//
// # Why the whole composition lives here rather than in main.go
//
// So it can be TESTED. main.go cannot be imported, so anything it decides is
// only observable by starting a process; a dropped Register* call would then be
// caught by a gateway E2E hours later, or by nothing. With the composition in an
// importable function, a forgotten seam fails a unit test against the route
// table at the commit that dropped it. main.go's remaining job is the part that
// genuinely cannot be tested in-process: reading the environment, opening
// sockets, and shutting them down.
//
// # The middleware ORDER is load-bearing, in both directions
//
//  1. gin.Recovery() is registered FIRST, which makes it the OUTERMOST.
//     LogContextMiddleware observes a panic, counts it as a 500 and RE-RAISES it —
//     producing the error response is still Recovery's job. Inverted, that
//     re-raise has nothing outside it to catch it and the panic escapes to
//     net/http: the connection is dropped with NO response rather than a 500.
//  2. otelgin.Middleware is next, and it MUST sit ABOVE LogContextMiddleware.
//     See the block below — this ordering is the difference between a request
//     line that can be joined to its trace and one that cannot.
//  3. LogContextMiddleware follows, still OUTSIDE routing, so a 401 from a key
//     guard and a 404 from the router — the requests people ask about most —
//     still get a request id and a log line. Users shipped the opposite ordering
//     and 401s had no id.
//  4. The two flag middlewares are last: they only annotate the request for the
//     handlers, and nothing above them reads what they set.
//
// # WHY otelgin GOES ABOVE LogContextMiddleware AND NOT BELOW
//
// Read otelgin's Middleware and the reason is structural rather than stylistic.
// It does two things around c.Next():
//
//	savedCtx := c.Request.Context()
//	defer func() { c.Request = c.Request.WithContext(savedCtx) }()  // RESTORES
//	ctx := propagators.Extract(savedCtx, HeaderCarrier(c.Request.Header))
//	ctx, span := tracer.Start(ctx, ...)
//	c.Request = c.Request.WithContext(ctx)                          // installs
//	c.Next()
//
// The span is on the request context only for the DURATION of c.Next(), and the
// deferred restore puts the pre-span context back on the way out.
//
// Registering otelgin EARLIER makes it OUTER, so the nesting is:
//
//	Recovery( otelgin( LogContext( flags( handler ) ) ) )
//
// LogContextMiddleware writes its one `request completed` line AFTER its own
// c.Next() returns — but that moment is still INSIDE otelgin's c.Next(), so the
// span is installed on the request context and TraceHandler stamps trace_id and
// span_id onto the line.
//
// Inverted, LogContextMiddleware becomes the outer one and its line is written
// after otelgin's deferred restore has already stripped the span: the request's
// context carries no span, TraceHandler finds no valid span context, and the
// line is emitted with trace_id and span_id OMITTED. Valid JSON, correct fields,
// silently unjoinable to the trace it belongs to — the same failure this service
// already shipped once (0 of 348 lines carried a trace_id) reappearing in a new
// place. That inversion is a mutation that fails
// TestTheRequestLineCarriesTheTraceID.
//
// It sits BELOW gin.Recovery for the same reason everything does: Recovery must
// stay outermost so a panic still produces a 500.
//
// GinFilter is passed so the liveness probe produces no span. Python excludes it
// with OTEL_PYTHON_FASTAPI_EXCLUDED_URLS="/v1/health$"; Go has no such variable,
// so DEFINING the filter is not excluding anything — it has to be handed over.
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
		// The INBOUND half of trace propagation, and the only thing that reads
		// the gateway's traceparent. Without it every workflow span this service
		// opens starts a NEW root trace: the flow still appears complete in
		// OpenObserve, just as a second unrelated trace beside the caller's.
		//
		// No provider or propagator is passed. otelgin falls back to
		// otel.GetTracerProvider() and otel.GetTextMapPropagator(), which
		// SetupTracing has already installed — and passing the globals
		// explicitly here would only reintroduce the option-versus-autodetection
		// trap that cost this repo three silent failures.
		otelgin.Middleware(logging.ServiceName, otelgin.WithFilter(tracing.GinFilter)),
		LogContextMiddleware(log, opts.Metrics),
		E2ESourceMiddleware(opts.E2ETestingEnabled),
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
		nil,
	))

	// The two user-scoped reads. READER pool — the only routes that use it.
	//
	// # They and ONLY they carry the identity stamp
	//
	// StampResolvedUserID is applied to a GROUP, not with router.Use, because
	// three of this service's surfaces have no caller identity at all: the
	// carrier PUT (its gateway route declares no authorizer), and both deletes
	// (API-key authenticated, subject in the body or in a tag). A global
	// middleware guarding on "is x-user-id present?" would still fire on a stray
	// header sent to the carrier PUT, and would silently start resolving on the
	// next route somebody adds. Per-route inverts the default — the same reason
	// RequireCallerSub is per-route rather than middleware-plus-an-allowlist,
	// and the direct equivalent of the Python's `IdentifiedCaller` dependency.
	//
	// Health is exempt by the same structure: the ALB probes it continuously,
	// and resolving there would turn a liveness check into a dependency on
	// Users being up.
	//
	// WITHOUT THIS LINE THE RESPONSE CACHE IS ENTIRELY INERT. Both read handlers
	// build their cache key from ResolvedUserID(c), and the key builders decline
	// to build one without a usr_ id — so nothing calling SetResolvedUserID means
	// every read is a MISS forever, while every part of the code looks correct.
	//
	// Creation is deliberately NOT in this group: it resolves the id itself and
	// answers 404 when Users has no record, and stamping first would change
	// nothing there (a negative is never cached, so it still makes its own call)
	// while blurring which path is allowed to fail.
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
		nil,
	), opts.CarrierAPIKey)

	// The account-deletion cascade's leg. Internal key, applied by the seam.
	softDeletes := adaptermysql.NewSoftDeleteRepository(opts.WriterDB)
	RegisterInternalDelete(router, NewInternalDeleteHandler(
		app.NewDeleteByUser(softDeletes, cache.NewUserInvalidator(gateway, log), nil),
		log,
		nil,
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
			app.NewE2ECleanup(softDeletes, nil), log, nil))
	}

	return router
}
