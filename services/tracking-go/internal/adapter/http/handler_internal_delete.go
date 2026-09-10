package http

import (
	"encoding/json"
	"errors"
	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	"log/slog"
	nethttp "net/http"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
)

// reasonDBError names a database fault while stamping the rows.
//
// The cascade's caller (Users) retries the leg, so the token names WHAT failed
// rather than which driver raised — the exception text carries that, and only on
// the log line and the span, never in the body.
const reasonDBError = "db_error"

// internalDeleteRequest is the body of DELETE /v1/trackings/by-user — a DELETE
// with a required body, because the caller is Users' account-deletion cascade
// and the identities arrive in the body rather than the x-user-id header.
//
// CONTRACT: Pointers, not plain strings, so "absent" and "present but empty"
// stay distinguishable at decode time. Both are rejected; conflating them makes
// the validation read as formatting, not the security control it is.
// See [[soft-delete]]
type internalDeleteRequest struct {
	// CONTRACT: BOTH identities travel — the ownership predicate matches either.
	// Pre-migration rows carry only user_id, and cognito_sub is not durable: a
	// user who re-registers gets a new one while their usr_ id never changes.
	CognitoSub *string `json:"cognito_sub"`
	UserID     *string `json:"user_id"`
}

// InternalDeleteHandler serves DELETE /v1/trackings/by-user, the Tracking leg of
// the account-deletion cascade.
//
// WARNING: Guarded by RequireInternalKey (GRPC_API_KEY), never the carrier key.
// Accepting a vendor's credential on a mass soft-delete lets it erase a user's
// delivery history. See [[two-api-keys-two-trust-domains]]
type InternalDeleteHandler struct {
	uc     *app.DeleteByUser
	log    *slog.Logger
	tracer trace.Tracer
}

// NewInternalDeleteHandler wires the handler.
func NewInternalDeleteHandler(uc *app.DeleteByUser, log *slog.Logger, tracer trace.Tracer) *InternalDeleteHandler {
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
	return &InternalDeleteHandler{uc: uc, log: log, tracer: tracer}
}

// RegisterInternalDelete mounts DELETE /v1/trackings/by-user BEHIND the internal
// key guard.
//
// CONTRACT: Apply the guard HERE, in the call that mounts the route — that is
// why this seam exists rather than two lines in main.go. A route mounted in one
// place and guarded in another is a route mounted without its guard, on the
// widest blast radius this service has. internalAPIKey is GRPC_API_KEY, NEVER
// TRACKING_CARRIER_API_KEY. See [[two-api-keys-two-trust-domains]]
//
// The `by-user` literal coexists with the :order_id wildcard only because these
// are DELETE and Gin keeps one radix tree per method — see NewRouter.
func RegisterInternalDelete(router gin.IRouter, handler *InternalDeleteHandler, internalAPIKey string) {
	group := router.Group("/v1/trackings", RequireInternalKey(internalAPIKey, handler.log))
	group.DELETE("/by-user", handler.Handle)
}

// Handle soft-deletes the user's trackings and, through the FK, their history.
//
// It NEVER logs the api key that authenticated it, in any form. Both identities
// are shared-context fields and travel on the flow lines; the count does not,
// because it is not one of the seven allowed context keys — it stays on the log
// call's own attributes.
func (h *InternalDeleteHandler) Handle(c *gin.Context) {
	payload, ok := h.decodeBody(c)
	if !ok {
		return
	}

	cognitoSub, userID := *payload.CognitoSub, *payload.UserID

	ctx := c.Request.Context()
	var span trace.Span
	if h.tracer != nil {
		ctx, span = h.tracer.Start(ctx, "internal_delete_by_user")
		defer span.End()
		span.SetAttributes(
			attribute.String("app_event", "internal_delete_by_user_started"),
			attribute.String("cognito_sub", cognitoSub),
			attribute.String("user_id", userID),
		)
	}

	h.log.InfoContext(ctx, "internal_delete_by_user_started",
		slog.String("app_event", "internal_delete_by_user_started"),
		slog.String("cognito_sub", cognitoSub),
		slog.String("user_id", userID))

	deleted, err := h.uc.Execute(ctx, cognitoSub, userID)
	switch {
	case errors.Is(err, app.ErrEmptyIdentity):
		// The field checks above already rejected empties, so reaching this is a
		// defect rather than a caller error. It is mapped to the SAME 422 anyway:
		// the two guards must not be able to disagree about the contract, and a
		// 500 here would report a database fault for a validation failure.
		c.JSON(nethttp.StatusUnprocessableEntity, NewValidationError(
			[]string{"body"},
			"String should have at least 1 character",
			"string_too_short"))
		return
	case err != nil:
		// CONTRACT: Keep this branch. Users calls both cascade legs before
		// touching the account, so a 500 here leaves the account alive with
		// Orders already swept; without the branch that 500 carries no
		// *_failed, no reason and no span attribute. The status is unchanged —
		// the error is reported, not translated. See [[logging-context]]
		setSpanReason(span, reasonDBError)
		h.log.ErrorContext(ctx, "internal_delete_by_user_failed",
			slog.String("app_event", "internal_delete_by_user_failed"),
			slog.String("reason", reasonDBError),
			slog.String("cognito_sub", cognitoSub),
			slog.String("user_id", userID),
			slog.String("error", err.Error()))
		c.JSON(nethttp.StatusInternalServerError, FlatError{Detail: "internal server error"})
		return
	}

	if span != nil {
		span.SetAttributes(
			attribute.String("app_event", "internal_delete_by_user_succeeded"),
			attribute.Int64("deleted_count", deleted),
		)
	}
	h.log.InfoContext(ctx, "internal_delete_by_user_succeeded",
		slog.String("app_event", "internal_delete_by_user_succeeded"),
		slog.String("cognito_sub", cognitoSub),
		slog.String("user_id", userID),
		slog.Int64("deleted_count", deleted))

	c.JSON(nethttp.StatusOK, DeletedResponse{Deleted: deleted})
}

// decodeBody parses and validates the body, answering 422 itself on failure.
// ok is false when a response has already been written.
func (h *InternalDeleteHandler) decodeBody(c *gin.Context) (internalDeleteRequest, bool) {
	var payload internalDeleteRequest

	// NO DisallowUnknownFields here, unlike init-tracking. That endpoint forbids
	// extras because an ignored `user_id` there would silently misattribute a
	// tracking; here the caller is a peer service whose payload may grow, and
	// rejecting an additive field would break the cascade on a Users deploy.
	if err := json.NewDecoder(c.Request.Body).Decode(&payload); err != nil {
		c.JSON(nethttp.StatusUnprocessableEntity,
			NewValidationError([]string{"body"}, err.Error(), "value_error"))
		return payload, false
	}

	// min_length=1 on BOTH, and it is a SECURITY control rather than a formatting
	// check. The predicate downstream is an OR, so an empty value on either side
	// could widen the match to any row carrying an empty string in that column —
	// someone else's data. The use case and the repository guard it again; this
	// is simply the earliest place to say no.
	for _, field := range []struct {
		name  string
		value *string
	}{
		{"cognito_sub", payload.CognitoSub},
		{"user_id", payload.UserID},
	} {
		if field.value == nil {
			c.JSON(nethttp.StatusUnprocessableEntity, NewValidationError(
				[]string{"body", field.name}, "Field required", "missing"))
			return payload, false
		}
		if *field.value == "" {
			c.JSON(nethttp.StatusUnprocessableEntity, NewValidationError(
				[]string{"body", field.name},
				"String should have at least 1 character",
				"string_too_short"))
			return payload, false
		}
	}

	return payload, true
}
