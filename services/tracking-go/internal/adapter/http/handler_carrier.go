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

// StatusTransitioner is the handler's own narrow port over the transition.
//
// It is an INTERFACE rather than *app.UpdateStatus because it is the same seam
// Wave 2.5's progression consumes: one method, one meaning of "a transition".
// Anything satisfying this cannot be a second transition path, because there is
// only one method to implement.
type StatusTransitioner interface {
	Execute(ctx context.Context, orderID string, requested domain.Status, actor audit.Actor) (domain.TrackingWithHistory, error)
}

// carrierRequest is the body.
//
// # status is a BARE STRING, deliberately not domain.Status
//
// Binding it as the enum would let the framework reject an unknown value before
// this handler ever ran — with a 422, while the design specifies 400. Routing
// ALL FOUR failure reasons (an unparseable status plus the three state-machine
// guards) through one place is what keeps them answering with the same status
// code and the same body shape. A client handling one handles all four.
//
// # It is a *string, and the pointer is load-bearing
//
// Pydantic declares `status: str` — REQUIRED and non-nullable — so the Python
// answers 422 for `{}` and for `{"status": null}`, and only 400 for a string
// that is not one of the five. Verified against the running service on
// 2026-08-27.
//
// Go's encoding/json decodes BOTH of those into the zero value "" on a plain
// string field, which would collapse "you sent no status" into "you sent an
// unknown status" and answer 400 where the Python answers 422 — a silent
// contract change on the one endpoint whose caller is a third party we cannot
// redeploy. A pointer keeps nil (absent or null) distinguishable from a present
// value.
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

// RegisterCarrierRoutes mounts the carrier surface with its key guard declared at
// the ROUTE GROUP level.
//
// # Why the guard is on the group and not on the route
//
// Every endpoint added to this group is then authenticated BY DEFAULT rather than
// open by default. A per-route guard makes the safe thing the thing you have to
// remember, and the next carrier endpoint ships unprotected the first time
// somebody forgets — on a surface that MUTATES DELIVERY STATE and sits behind no
// Cognito authorizer at all. This service is the only thing standing in front of
// it.
//
// The key is TRACKING_CARRIER_API_KEY, an EXTERNAL vendor credential. It is NOT
// GRPC_API_KEY, the internal service-to-service secret: reusing one as the other
// would hand an outside party a credential valid against every internal surface
// we have, the mass soft-delete route included.
func RegisterCarrierRoutes(router *gin.Engine, handler *CarrierHandler, carrierAPIKey string) {
	carrier := router.Group(carrierPrefix, RequireCarrierKey(carrierAPIKey, handler.log))
	carrier.PUT("/:order_id/status", handler.Handle)
}

// Handle advances a tracking's status on a carrier callback.
//
// # This route receives NO caller identity, and must never acquire one
//
// Its gateway route declares no Cognito authorizer, so no x-user-id reaches the
// service. The tracking is identified by order_id ALONE, through the UNSCOPED
// read. Applying the reads' ownership filter here would 404 every carrier call —
// including the rightful owner's — while looking perfectly implemented.
func (h *CarrierHandler) Handle(c *gin.Context) {
	orderID := c.Param("order_id")

	var payload carrierRequest
	if err := c.ShouldBindJSON(&payload); err != nil {
		// Not a JSON object at all, or `status` present with a non-string type.
		// Pydantic reports these as json_invalid / string_type; both are 422.
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

// reject renders the 400.
//
// # Shape C — FLAT, with `reason` as a TOP-LEVEL field
//
// Deliberately NOT init-tracking's nested shape. A client can reach the reason
// without knowing a framework's detail-wrapping convention, and all four reasons
// (invalid_status plus the three guards) answer with this one shape. The two
// shapes are not unified because each is already observable by a shipped client;
// collapsing them would be a silent breaking change for whichever caller reads
// the field that moved.
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
