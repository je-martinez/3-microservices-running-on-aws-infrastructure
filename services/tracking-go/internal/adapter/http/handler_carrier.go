package http

import (
	"context"
	"errors"
	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	"log/slog"
	nethttp "net/http"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

const (
	// carrierPrefix is the ROUTE GROUP every carrier endpoint hangs off. Named
	// once so a future sibling endpoint cannot be mounted outside the guarded
	// group by mistyping the path.
	carrierPrefix = "/v1/trackings"

	appEventCarrierStarted   = "carrier_status_update_started"
	appEventCarrierSucceeded = "carrier_status_update_succeeded"
	appEventCarrierFailed    = "carrier_status_update_failed"

	// reasonInvalidStatus is the fourth 400 reason, beside the state machine's
	// three. All four share ONE vocabulary and ONE body shape, which is the whole
	// point of binding `status` as a bare string rather than as the enum.
	reasonInvalidStatus = "invalid_status"
)

// StatusTransitioner is the handler's own narrow port over the transition. An
// interface, not *app.UpdateStatus, because the progression consumes the same
// seam: one method, so nothing satisfying it can be a second transition path.
type StatusTransitioner interface {
	Execute(ctx context.Context, orderID string, requested domain.Status, actor audit.Actor) (domain.TrackingWithHistory, error)
}

// carrierRequest is the body.
//
// CONTRACT: Bind status as a bare string, not domain.Status. The enum lets the
// framework reject an unknown value as 422 before this handler runs, while the
// contract is 400 — and routing all four failure reasons through one place is
// what keeps their status code and body shape identical.
//
// CONTRACT: Keep the *string. encoding/json decodes both `{}` and
// `{"status": null}` into "" on a plain field, collapsing "no status" (422) into
// "unknown status" (400) on the one endpoint whose caller is a third party we
// cannot redeploy. See [[openapi-specs]]
type carrierRequest struct {
	Status *string `json:"status"`
}

// CarrierHandler serves PUT /v1/trackings/{order_id}/status, the third-party
// carrier webhook.
type CarrierHandler struct {
	uc     StatusTransitioner
	log    *slog.Logger
	tracer trace.Tracer
}

// NewCarrierHandler wires the handler. A nil logger falls back to the default so
// a partially-wired process logs somewhere rather than panicking on the first
// carrier callback.
func NewCarrierHandler(uc StatusTransitioner, log *slog.Logger, tracer trace.Tracer) *CarrierHandler {
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
	return &CarrierHandler{uc: uc, log: log, tracer: tracer}
}

// RegisterCarrierRoutes mounts the carrier surface with its key guard on the
// ROUTE GROUP.
//
// CONTRACT: Keep the guard on the group, never per route, so every endpoint
// added here is authenticated by default. This surface mutates delivery state
// behind no Cognito authorizer, so a forgotten per-route guard ships an open
// mutation endpoint. The key is TRACKING_CARRIER_API_KEY, never GRPC_API_KEY.
// See [[two-api-keys-two-trust-domains]]
func RegisterCarrierRoutes(router *gin.Engine, handler *CarrierHandler, carrierAPIKey string) {
	carrier := router.Group(carrierPrefix, RequireCarrierKey(carrierAPIKey, handler.log))
	carrier.PUT("/:order_id/status", handler.Handle)
}

// Handle advances a tracking's status on a carrier callback.
//
// CONTRACT: This route receives NO caller identity and must never acquire one.
// The tracking is found by order_id alone through the UNSCOPED read; applying
// the ownership filter 404s every carrier call, the owner's included, while
// looking implemented. See [[user-id-vs-cognito-sub-ownership-key]]
func (h *CarrierHandler) Handle(c *gin.Context) {
	orderID := c.Param("order_id")

	var payload carrierRequest
	if err := c.ShouldBindJSON(&payload); err != nil {
		// Not a JSON object at all, or `status` present with a non-string type.
		// Both answer 422.
		c.JSON(nethttp.StatusUnprocessableEntity,
			NewValidationError([]string{"body", "status"},
				"Input should be a valid string", "string_type"))
		return
	}
	if payload.Status == nil {
		// Absent, or explicitly null. Pydantic's required-field error, and the
		// ONE failure on this route that is not a 400: the request never got as
		// far as having a status VALUE to reject.
		c.JSON(nethttp.StatusUnprocessableEntity,
			NewValidationError([]string{"body", "status"}, "Field required", "missing"))
		return
	}

	ctx := c.Request.Context()
	var span trace.Span
	if h.tracer != nil {
		ctx, span = h.tracer.Start(ctx, "carrier_status_update")
		defer span.End()
		span.SetAttributes(
			attribute.String("app_event", appEventCarrierStarted),
			attribute.String("order_id", orderID),
		)
	}

	requested, err := domain.ParseStatus(*payload.Status)
	if err != nil {
		// Rejected before anything was read, so nothing was written. The message
		// is the domain's own and names every accepted value, so a carrier
		// integrator can fix the call from the response alone.
		h.reject(ctx, c, span, orderID, err.Error(), reasonInvalidStatus)
		return
	}

	// The ZERO actor, deliberately: the DEFAULT lives in the use case, which is
	// also what TestMode progression calls. Naming audit.CarrierStatusUpdate here
	// would put the default in two places.
	updated, err := h.uc.Execute(ctx, orderID, requested, "")
	switch {
	case errors.Is(err, domain.ErrTrackingNotFound):
		// There is no ownership dimension on this route, so a 404 genuinely means
		// the order has no tracking — unlike the user-scoped reads, where a 404
		// also covers "someone else's".
		setSpanReason(span, "not_found")
		h.logFailure(ctx, orderID, "not_found")
		c.JSON(nethttp.StatusNotFound, FlatError{Detail: "tracking not found"})
		return
	case err != nil:
		var invalid *domain.InvalidTransitionError
		if errors.As(err, &invalid) {
			// The state machine's three guards, each with its own reason. The
			// guard ORDER is load-bearing and lives in the domain: terminality is
			// checked first, so DELIVERED -> anything reports already_delivered
			// even when it is also backward or equal.
			h.reject(ctx, c, span, orderID, invalid.Error(), string(invalid.Reason))
			return
		}
		setSpanReason(span, "internal_error")
		h.log.ErrorContext(ctx, appEventCarrierFailed,
			slog.String("app_event", appEventCarrierFailed),
			slog.String("reason", "internal_error"),
			slog.String("order_id", orderID),
			// For operators only. The body below says nothing about the cause.
			slog.String("error", err.Error()))
		c.JSON(nethttp.StatusInternalServerError, FlatError{Detail: "internal server error"})
		return
	}

	if span != nil {
		span.SetAttributes(
			attribute.String("app_event", appEventCarrierSucceeded),
			attribute.String("tracking_id", updated.Tracking.ID),
			attribute.String("status", string(updated.Tracking.Status)),
		)
	}
	// There is NO SUCCESS severity — success is INFO plus app_event=*_succeeded.
	// No user_id and no cognito_sub: this request carries no user identity, and
	// the convention OMITS unknown fields rather than emitting null. No
	// shipping_address, ever: it is PII.
	h.log.InfoContext(ctx, appEventCarrierSucceeded,
		slog.String("app_event", appEventCarrierSucceeded),
		slog.String("order_id", orderID),
		slog.String("tracking_id", updated.Tracking.ID),
		slog.String("status", string(updated.Tracking.Status)))

	// FLAT, not wrapped: only init-tracking's 201 nests the tracking under a
	// "tracking" key. NewTrackingResponse is physically incapable of carrying
	// shipping_address or cognito_sub.
	c.JSON(nethttp.StatusOK, NewTrackingResponse(updated))
}

// reject renders the 400 in Shape C: FLAT, with `reason` top-level.
//
// CONTRACT: Do NOT unify this with init-tracking's nested shape. Both are
// already observable by shipped clients, so collapsing them silently breaks
// whichever caller reads the field that moved. See [[openapi-specs]]
func (h *CarrierHandler) reject(
	ctx context.Context, c *gin.Context, span trace.Span, orderID, detail, reason string,
) {
	setSpanReason(span, reason)
	h.logFailure(ctx, orderID, reason)
	c.JSON(nethttp.StatusBadRequest, ReasonError{Detail: detail, Reason: reason})
}

// logFailure emits *_failed with the SAME token the span carries, set beside it
// so the two cannot drift.
//
// No user_id and no cognito_sub field: this request has no user identity at all,
// and the convention omits unknown fields rather than emitting null. The API key
// is NEVER logged — not the value, not a prefix, not its length.
func (h *CarrierHandler) logFailure(ctx context.Context, orderID, reason string) {
	h.log.WarnContext(ctx, appEventCarrierFailed,
		slog.String("app_event", appEventCarrierFailed),
		slog.String("reason", reason),
		slog.String("order_id", orderID))
}
