package http

import (
	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	"log/slog"
	nethttp "net/http"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
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
	uc     *app.E2ECleanup
	log    *slog.Logger
	tracer trace.Tracer
}

// NewE2ECleanupHandler wires the handler.
func NewE2ECleanupHandler(uc *app.E2ECleanup, log *slog.Logger, tracer trace.Tracer) *E2ECleanupHandler {
	if log == nil {
		log = slog.Default()
	}
	if tracer == nil {
		// CONTRACT: Default the tracer here. A nil one silently disables the
		// workflow span, which is how a trace says WHICH operation ran, while
		// unit tests that inject a tracer stay green.
		// See [[2026-08-27-a-component-can-be-fully-unit-tested-and-still-never-run-in-production]]
		tracer = tracing.Tracer(tracing.TracerWorkflow)
	}
	return &E2ECleanupHandler{uc: uc, log: log, tracer: tracer}
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
	ctx := c.Request.Context()
	var span trace.Span
	if h.tracer != nil {
		ctx, span = h.tracer.Start(ctx, "e2e_cleanup")
		defer span.End()
		span.SetAttributes(attribute.String("app_event", "e2e_cleanup_started"))
	}

	// `run_id` is a QUERY PARAM so it appears in the access log, which is what
	// reconstructs which run deleted what. A malformed value is discarded rather
	// than rejected: a teardown that 400s leaves fixtures for the next run.
	runTag := E2ERunTag(ValidRunID(c.Query("run_id")))

	deleted, err := h.uc.ExecuteScoped(ctx, runTag)
	if err != nil {
		setSpanReason(span, reasonDBError)
		h.log.ErrorContext(ctx, "e2e_cleanup_failed",
			slog.String("app_event", "e2e_cleanup_failed"),
			slog.String("reason", reasonDBError),
			slog.String("error", err.Error()))
		c.JSON(nethttp.StatusInternalServerError, FlatError{Detail: "internal server error"})
		return
	}

	if span != nil {
		span.SetAttributes(
			attribute.String("app_event", "e2e_cleanup_succeeded"),
			attribute.Int64("deleted_count", deleted),
		)
	}
	h.log.InfoContext(ctx, "e2e_cleanup_succeeded",
		slog.String("app_event", "e2e_cleanup_succeeded"),
		slog.Int64("deleted_count", deleted))

	c.JSON(nethttp.StatusOK, DeletedResponse{Deleted: deleted})
}
