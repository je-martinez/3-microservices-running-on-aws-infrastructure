package http

import (
	"database/sql"
	"log/slog"

	"github.com/gin-gonic/gin"

	adaptermysql "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
)

// WireReads builds and mounts the two user-scoped reads.
//
// # Why the composition of THESE routes lives in a function rather than inline
// # in main
//
// Five endpoints are being ported in parallel and every one of them appends to
// the same composition root. A one-line call per feature is what keeps that file
// mergeable, and it keeps the wiring of a feature next to the feature — the
// reader who wants to know which reader a read uses does not have to open main.
//
// The composition root still OWNS the decision: it passes the pool, the gateway
// and the flag. Nothing is constructed here that a test could not construct
// differently, which is why the handler's own constructor stays exported and the
// tests use it directly rather than going through this.
func WireReads(
	router gin.IRouter,
	db *sql.DB,
	gateway cache.Gateway,
	cacheEnabled bool,
	log *slog.Logger,
) {
	reader := adaptermysql.NewTrackingReader(db)
	RegisterReads(router, NewReadsHandler(
		// TWO SEPARATE use cases over the SAME adapter, each holding its own
		// one-method port. The adapter satisfies both structurally; neither use
		// case can reach the other's method.
		app.NewGetMyTracking(reader),
		app.NewListMyTrackings(reader),
		gateway,
		cacheEnabled,
		log,
	))
}
