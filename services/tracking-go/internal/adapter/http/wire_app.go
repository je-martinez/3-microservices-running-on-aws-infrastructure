package http

import (
	"database/sql"
	"log/slog"

	"github.com/gin-gonic/gin"

	adaptermysql "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/notify"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
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
//  2. LogContextMiddleware is next, still OUTSIDE routing, so a 401 from a key
//     guard and a 404 from the router — the requests people ask about most —
//     still get a request id and a log line. Users shipped the opposite ordering
//     and 401s had no id.
//  3. The two flag middlewares are last: they only annotate the request for the
//     handlers, and nothing above them reads what they set.
func NewAppRouter(opts AppRouterOptions) *gin.Engine {
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}

	router := gin.New()
	router.Use(
		gin.Recovery(),
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
	WireReads(router, opts.ReaderDB, opts.Gateway, opts.CacheEnabled, log)

	// The carrier webhook. Its own external key, declared at the group level.
	RegisterCarrierRoutes(router, NewCarrierHandler(
		app.NewUpdateStatus(
			adaptermysql.NewStatusRepository(opts.WriterDB),
			notify.NewStatusEventPublisher(opts.Publisher),
			notify.NewTrackingCacheInvalidator(opts.Gateway, log),
			nil,
		),
		log,
		nil,
	), opts.CarrierAPIKey)

	// The account-deletion cascade's leg. Internal key, applied by the seam.
	softDeletes := adaptermysql.NewSoftDeleteRepository(opts.WriterDB)
	RegisterInternalDelete(router, NewInternalDeleteHandler(
		app.NewDeleteByUser(softDeletes, cache.NewUserInvalidator(opts.Gateway, log), nil),
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
