package http

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	nethttp "net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

const (
	// reasonUnknownUser names the 404's cause. The same token Orders returns for
	// the identical condition on POST /v1/orders — two services facing the same
	// condition must not teach clients two different vocabularies.
	reasonUnknownUser = "unknown_user"
	// reasonAlreadyExists names the RULE, not the mechanism. A caller should not
	// have to know a unique index is involved.
	reasonAlreadyExists = "tracking_already_exists"
	// reasonInternalError is for the log and the span ONLY, never the body.
	reasonInternalError = "internal_error"
)

// maxOrderIDLength mirrors Pydantic's max_length=ID_LENGTH. 28 is the width of
// every id-bearing column, so a longer value would be TRUNCATED by MySQL rather
// than rejected — stored as an id that looks fine and matches nothing.
const maxOrderIDLength = domain.IDLength

// ProgressionHook is the TestMode seam.
//
// Wave 2 wires the no-op; Wave 2.5 supplies the real progression. It is an
// interface rather than a func so the no-op is a NAMED type an operator reading
// the wiring can recognise as "deliberately does nothing" instead of an empty
// closure that looks like an oversight.
type ProgressionHook interface {
	Start(tracking domain.TrackingWithHistory)
}

// NoopProgression is the Wave 2 wiring: creation works, nothing advances.
type NoopProgression struct{}

// Start does nothing. See ProgressionHook.
func (NoopProgression) Start(domain.TrackingWithHistory) {}

// initTrackingRequest is the body — two fields, and deliberately NO identity.
//
// A user_id or cognito_sub field here would be an unauthenticated string a client
// chooses, so anyone could create a tracking attributed to anyone. The body is
// client input; the x-user-id header is a gateway assertion derived from a
// verified JWT.
type initTrackingRequest struct {
	OrderID string `json:"order_id"`
	// json.RawMessage, not map[string]any: the address is stored byte-for-byte and
	// never inspected, so round-tripping it through a Go map would reorder keys and
	// re-encode numbers for no reason. nil means absent — the column stays NULL.
	ShippingAddress json.RawMessage `json:"shipping_address"`
}

// InitTrackingHandler serves POST /v1/trackings/init-tracking.
type InitTrackingHandler struct {
	uc     *app.CreateTracking
	hook   ProgressionHook
	log    *slog.Logger
	tracer trace.Tracer
}

// NewInitTrackingHandler wires the handler. A nil hook becomes the no-op, so a
// caller that has not reached Wave 2.5 cannot nil-panic on a TestMode request.
func NewInitTrackingHandler(
	uc *app.CreateTracking, hook ProgressionHook, log *slog.Logger, tracer trace.Tracer,
) *InitTrackingHandler {
	if hook == nil {
		hook = NoopProgression{}
	}
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
	return &InitTrackingHandler{uc: uc, hook: hook, log: log, tracer: tracer}
}

// RegisterInitTracking mounts POST /v1/trackings/init-tracking.
//
// The literal path segment is registered here rather than inline in main so the
// route and its handler stay in one file. Registering a POST literal is safe
// beside GET /v1/trackings/:order_id because Gin keeps ONE radix tree PER METHOD
// and the two live in different trees — but a GET literal under the same prefix
// would collide with that wildcard and PANIC THE PROCESS AT STARTUP. See
// NewRouter.
//
// The E2E-source and test-mode middlewares are applied by the router, not here:
// several routes need them, and E2ESourceMiddleware also carries the
// E2E_TESTING_ENABLED flag that only the composition root knows.
func RegisterInitTracking(router gin.IRoutes, handler *InitTrackingHandler) {
	router.POST("/v1/trackings/init-tracking", handler.Handle)
}

// Handle creates a tracking at PLACED with its first history row.
//
// It NEVER logs payload.ShippingAddress: it is PII. The success line carries
// order_id, user_id, cognito_sub and tracking_id, all shared-context fields.
func (h *InitTrackingHandler) Handle(c *gin.Context) {
	// The caller identity comes from the header, never the body. EMPTY IS
	// MISSING: nginx sets x-user-id to "" for a missing or malformed token rather
	// than omitting it, and accepting "" would store a tracking owned by the empty
	// string, which any other malformed request could then read.
	cognitoSub := strings.TrimSpace(c.GetHeader(UserIDHeader))
	if cognitoSub == "" {
		c.JSON(nethttp.StatusUnauthorized, FlatError{Detail: "missing x-user-id"})
		return
	}

	payload, ok := h.decodeBody(c)
	if !ok {
		return
	}

	ctx := c.Request.Context()
	var span trace.Span
	if h.tracer != nil {
		ctx, span = h.tracer.Start(ctx, "init_tracking")
		defer span.End()
		span.SetAttributes(
			attribute.String("app_event", "init_tracking_started"),
			attribute.String("order_id", payload.OrderID),
		)
	}

	created, err := h.uc.Execute(ctx, app.CreateTrackingInput{
		OrderID:    payload.OrderID,
		CognitoSub: cognitoSub,
		// Free-form by design; never logged (PII).
		ShippingAddress: payload.ShippingAddress,
		// Already the AND of the header and E2E_TESTING_ENABLED — the middleware
		// evaluates both, so this handler cannot tag a row on the header alone.
		E2ESource: IsE2ESource(c),
		E2ERunTag: E2ERunTag(E2ERunID(c)),
	})
	switch {
	case errors.Is(err, app.ErrUnknownUser):
		// Authenticated, but Users has no record. A 404, not a 401: the same valid
		// token will produce the same missing record forever.
		setSpanReason(span, reasonUnknownUser)
		h.logFailure(ctx, payload.OrderID, reasonUnknownUser, cognitoSub)
		c.JSON(nethttp.StatusNotFound, NestedError{Detail: NestedErrorBody{
			Detail: err.Error(), Reason: reasonUnknownUser,
		}})
		return
	case errors.Is(err, domain.ErrTrackingAlreadyExists):
		// Either the pre-check found one or the unique index rejected a racing
		// INSERT. The SAME answer for both is what keeps a lost race a 409 rather
		// than a 500, so a retry can never duplicate a shipment.
		setSpanReason(span, reasonAlreadyExists)
		h.logFailure(ctx, payload.OrderID, reasonAlreadyExists, cognitoSub)
		c.JSON(nethttp.StatusConflict, NestedError{Detail: NestedErrorBody{
			Detail: err.Error(), Reason: reasonAlreadyExists,
		}})
		return
	case err != nil:
		// Every remaining case, a Users outage included, is a 500. Deliberately
		// NOT folded into the 404 above: an outage must never read as "this user
		// does not exist".
		setSpanReason(span, reasonInternalError)
		h.log.ErrorContext(ctx, "init_tracking_failed",
			slog.String("app_event", "init_tracking_failed"),
			slog.String("reason", reasonInternalError),
			slog.String("order_id", payload.OrderID),
			slog.String("error", err.Error()))
		// The body says nothing about the cause: the detail above is for operators.
		c.JSON(nethttp.StatusInternalServerError, FlatError{Detail: "internal server error"})
		return
	}

	if span != nil {
		span.SetAttributes(
			attribute.String("app_event", "init_tracking_succeeded"),
			attribute.String("tracking_id", created.Tracking.ID),
			attribute.String("user_id", created.Tracking.UserID),
			attribute.Bool("test_mode", IsTestMode(c)),
		)
	}
	h.log.InfoContext(ctx, "init_tracking_succeeded",
		slog.String("app_event", "init_tracking_succeeded"),
		slog.String("order_id", payload.OrderID),
		slog.String("tracking_id", created.Tracking.ID),
		slog.String("user_id", created.Tracking.UserID),
		slog.String("cognito_sub", cognitoSub),
		slog.Bool("test_mode", IsTestMode(c)))

	// The response is written — and the transaction was committed by the adapter
	// before Execute returned — BEFORE the hook is invoked. The returned value is
	// therefore an authoritative committed snapshot, not request input assembled
	// before persistence, and the client observes creation before any background
	// status notification.
	c.JSON(nethttp.StatusCreated, InitTrackingResponse{Tracking: NewTrackingResponse(created)})

	if IsTestMode(c) {
		// Pass the committed creation snapshot into the background run. A global
		// E2E cleanup can soft-delete the row immediately after this response;
		// retaining the snapshot lets progression finish publishing without a
		// race to re-read data that teardown has already hidden.
		h.hook.Start(created)
	}
}

// decodeBody parses and validates the body, answering 422 itself on failure.
// ok is false when a response has already been written.
func (h *InitTrackingHandler) decodeBody(c *gin.Context) (initTrackingRequest, bool) {
	var payload initTrackingRequest

	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(nethttp.StatusUnprocessableEntity,
			NewValidationError([]string{"body"}, "could not read request body", "value_error"))
		return payload, false
	}

	// DisallowUnknownFields mirrors Pydantic's extra="forbid", and ONLY this
	// endpoint has it. encoding/json otherwise ignores unknown fields SILENTLY,
	// which would let a client send `user_id`, have it dropped without a word, and
	// then wonder why the tracking belongs to somebody else. The 422 must NAME the
	// field, exactly as Pydantic's does.
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()

	if err := dec.Decode(&payload); err != nil {
		if field, ok := unknownField(err); ok {
			c.JSON(nethttp.StatusUnprocessableEntity, NewValidationError(
				[]string{"body", field},
				"Extra inputs are not permitted",
				"extra_forbidden",
			))
			return payload, false
		}
		c.JSON(nethttp.StatusUnprocessableEntity,
			NewValidationError([]string{"body"}, err.Error(), "value_error"))
		return payload, false
	}

	if payload.OrderID == "" || len(payload.OrderID) > maxOrderIDLength {
		c.JSON(nethttp.StatusUnprocessableEntity, NewValidationError(
			[]string{"body", "order_id"},
			"String should have at least 1 character and at most 28 characters",
			"string_too_long",
		))
		return payload, false
	}

	return payload, true
}

// unknownField extracts the field name out of encoding/json's
// `json: unknown field "x"` error, so the 422 can NAME it the way Pydantic does.
//
// A string match on a standard-library message is fragile by nature, which is why
// the handler falls back to a generic 422 when it does not match: the status is
// right either way, and only the field name is lost. The handler test asserts the
// name is present, so a wording change in the standard library fails a test rather
// than shipping a vaguer error.
func unknownField(err error) (string, bool) {
	const prefix = `json: unknown field `
	msg := err.Error()
	i := strings.Index(msg, prefix)
	if i < 0 {
		return "", false
	}
	return strings.Trim(msg[i+len(prefix):], `"`), true
}

// setSpanReason keeps the span's `reason` and the *_failed line's `reason` the
// same token, set side by side, because they drift the moment one is updated
// alone.
func setSpanReason(span trace.Span, reason string) {
	if span == nil {
		return
	}
	span.SetAttributes(attribute.String("reason", reason))
}

// logFailure emits the *_failed event with its machine-readable reason.
//
// No user_id: on both failure paths it is unresolvable or irrelevant, and the
// convention OMITS unknown fields rather than logging null. The shipping address
// is never logged.
func (h *InitTrackingHandler) logFailure(ctx context.Context, orderID, reason, cognitoSub string) {
	h.log.WarnContext(ctx, "init_tracking_failed",
		slog.String("app_event", "init_tracking_failed"),
		slog.String("reason", reason),
		slog.String("order_id", orderID),
		slog.String("cognito_sub", cognitoSub))
}
