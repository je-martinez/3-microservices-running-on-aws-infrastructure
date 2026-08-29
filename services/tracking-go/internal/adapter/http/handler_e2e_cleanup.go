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

// E2ECleanupHandler serves DELETE /v1/trackings/e2e-cleanup, the E2E suite's
// teardown.
//
// # No caller identity, and that is the point
//
// This handler reads NO x-user-id and NO api key. The harness's teardown runs
// once, globally, at the end of a suite: there is no user session to run it as,
// so a route requiring a caller would answer 401 to its only real caller. An
// earlier version of this endpoint did exactly that.
//
// What protects it instead is a conjunction that lives elsewhere:
//   - the route is REGISTERED only when E2E_TESTING_ENABLED (see the router
//     wiring) — with the flag off it does not exist at all;
//   - it deletes only rows tagged "E2E Source", and a row is tagged only when the
//     request sent x-e2e-source: true AND that same flag was on (see
//     E2ESourceMiddleware).
//
// Both halves are required. Without the second, any client could tag its own rows
// and enlist them for somebody else's teardown to delete. Every row a real user
// created is untagged and therefore untouchable here.
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
		// A nil tracer silently disables this handler's workflow span, and the
		// span is how a trace says WHICH business operation ran -- the server
		// span from otelgin only says a request arrived. That is exactly how the
		// four workflow spans went missing in production while their unit tests,
		// which inject a tracer, stayed green. Defaulting here means forgetting
		// the argument costs nothing, matching how log and hook already behave.
		tracer = tracing.Tracer(tracing.TracerWorkflow)
	}
	return &E2ECleanupHandler{uc: uc, log: log, tracer: tracer}
}

// RegisterE2ECleanup mounts DELETE /v1/trackings/e2e-cleanup.
//
// # CALL THIS ONLY WHEN E2E_TESTING_ENABLED
//
// The flag check is the CALLER's, deliberately, and this function takes no flag
// argument at all. A guard parameter here would make "registered but refusing" an
// expressible state, and a route that exists and answers 403 is still a route: it
// appears in the OpenAPI document, it is probeable, and it is one edited condition
// away from being live. Not existing is the stronger guarantee, and it is what the
// Python does (`if e2e_testing_enabled(): app.include_router(...)`) and what Users
// and Orders both do.
//
// With the flag off and the route absent, a DELETE to this path answers 405 rather
// than 404 — GET /v1/trackings/:order_id matches it in another method's tree and
// HandleMethodNotAllowed is on. That 405 is the Python's answer too.
//
// No auth middleware, and that is not an omission: the harness's teardown runs
// once, globally, with no user session, so a route requiring a caller would answer
// 401 to its only real caller. What protects it is the conjunction documented on
// E2ECleanupHandler — this registration being conditional is one half of it.
func RegisterE2ECleanup(router gin.IRoutes, handler *E2ECleanupHandler) {
	router.DELETE("/v1/trackings/e2e-cleanup", handler.Handle)
}

// Handle soft-deletes every live tracking tagged as an E2E fixture.
//
// 200 with {"deleted": N} rather than a bodiless 204, ALWAYS — including zero
// matches. "The suite still sees its fixtures" and "the cleanup matched nothing"
// are the same symptom from the harness's side, so the count is what makes a
// teardown diagnosable without reading this service's logs. A re-run reporting
// {"deleted": 0} is a success, not a failure.
//
// No cognito_sub on the log lines: there is no caller identity on this request,
// and the convention OMITS unknown fields rather than emitting null or "".
func (h *E2ECleanupHandler) Handle(c *gin.Context) {
	ctx := c.Request.Context()
	var span trace.Span
	if h.tracer != nil {
		ctx, span = h.tracer.Start(ctx, "e2e_cleanup")
		defer span.End()
		span.SetAttributes(attribute.String("app_event", "e2e_cleanup_started"))
	}

	deleted, err := h.uc.Execute(ctx)
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
