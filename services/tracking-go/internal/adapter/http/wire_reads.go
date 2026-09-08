package http

import (
	"database/sql"
	"log/slog"

	"github.com/gin-gonic/gin"

	adaptermysql "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
)

// WireReads builds and mounts the two user-scoped reads. A function rather than
// inline wiring, so each feature costs the composition root one line and its
// wiring sits beside the feature.
//
// The composition root still owns the decision — it passes the pool, gateway and
// flag — and the handler's constructor stays exported so tests bypass this.
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
