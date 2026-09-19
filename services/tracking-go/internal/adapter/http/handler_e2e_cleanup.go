package http

import (
	"log/slog"
	nethttp "net/http"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/trace"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/bus"
)

// E2ECleanupHandler serves DELETE /v1/trackings/e2e-cleanup, the E2E teardown.
//
// CONTRACT: This handler reads no x-user-id and no API key — the teardown runs
// once globally with no user session, so requiring a caller 401s its only real
// caller. Two things protect it instead, and BOTH are required: the route is
// registered only under E2E_TESTING_ENABLED, and it deletes only rows tagged
// "E2E Source", which E2ESourceMiddleware grants only under that same flag.
// See [[testing]]
type E2ECleanupHandler struct {
	sweep bus.Handler[app.E2ECleanupCommand, int64]
	log   *slog.Logger
}

// NewE2ECleanupHandler wires the use case behind its bus pipeline.
//
// CONTRACT: The tracer parameter is retained and IGNORED. The pipeline resolves
// its tracer from the provider the composition root installed, so there is no
// argument left that can arrive empty and silently disable the workflow span —
// which is how a trace says WHICH operation ran, while unit tests injecting a
// tracer stay green.
// See [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]]
func NewE2ECleanupHandler(uc *app.E2ECleanup, log *slog.Logger, _ trace.Tracer) *E2ECleanupHandler {
	if log == nil {
		log = slog.Default()
	}
	return &E2ECleanupHandler{sweep: WrapE2ECleanup(uc, log), log: log}
}

// RegisterE2ECleanup mounts DELETE /v1/trackings/e2e-cleanup.
//
// CONTRACT: Call this ONLY when E2E_TESTING_ENABLED, and do NOT add a flag
// argument. A guard parameter makes "registered but refusing" expressible, and a
// route answering 403 still appears in the OpenAPI document and is one edited
// condition from live. Absent is the stronger guarantee. With it absent a DELETE
// here answers 405, since GET /v1/trackings/:order_id matches in another tree.
// See [[testing]]
func RegisterE2ECleanup(router gin.IRoutes, handler *E2ECleanupHandler) {
	router.DELETE("/v1/trackings/e2e-cleanup", handler.Handle)
}

// Handle soft-deletes every live tracking tagged as an E2E fixture.
//
// CONTRACT: Always 200 with {"deleted": N}, never a bodiless 204 — "the suite
// still sees its fixtures" and "the cleanup matched nothing" are one symptom
// from the harness's side, and {"deleted": 0} is a success. No cognito_sub on
// the log lines: unknown fields are omitted, never null. See [[logging-context]]
func (h *E2ECleanupHandler) Handle(c *gin.Context) {
	// `run_id` is a QUERY PARAM so it appears in the access log, which is what
	// reconstructs which run deleted what. A malformed value is discarded rather
	// than rejected: a teardown that 400s leaves fixtures for the next run.
	runTag := E2ERunTag(ValidRunID(c.Query("run_id")))

	deleted, err := h.sweep(c.Request.Context(), app.E2ECleanupCommand{RunTag: runTag})
	if err != nil {
		c.JSON(nethttp.StatusInternalServerError, FlatError{Detail: "internal server error"})
		return
	}

	c.JSON(nethttp.StatusOK, DeletedResponse{Deleted: deleted})
}
