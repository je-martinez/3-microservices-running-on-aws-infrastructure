package http

import (
	"encoding/json"
	"errors"
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

// internalDeleteRequest is the body of DELETE /v1/trackings/by-user.
//
// A DELETE WITH A REQUIRED BODY, which is unusual but deliberate: this is the one
// route where the two identities arrive in the body rather than the x-user-id
// header, because the caller is Users' account-deletion cascade and not a user
// session.
//
// Pointers, not plain strings, so "absent" and "present but empty" are
// distinguishable at decode time. Both are rejected, but conflating them would
// make the validation read as a formatting check rather than the security control
// it is.
type internalDeleteRequest struct {
	// BOTH identities travel because the ownership predicate matches either.
	// Rows predating the cognito_sub migration carry only user_id, and
	// cognito_sub is not durable — a user who deletes and re-registers gets a new
	// one while their usr_ id never changes.
	CognitoSub *string `json:"cognito_sub"`
	UserID     *string `json:"user_id"`
}

// InternalDeleteHandler serves DELETE /v1/trackings/by-user, the Tracking leg of
// the account-deletion cascade.
//
// It is guarded by RequireInternalKey (GRPC_API_KEY), never the carrier key: a
// mass soft-delete surface is the widest blast radius this service has, and
// accepting an external vendor's credential here would let it erase a user's
// delivery history.
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
	return &InternalDeleteHandler{uc: uc, log: log, tracer: tracer}
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
		// A fault here aborts the whole deletion: Users calls both cascade legs
		// BEFORE touching the account, so a 500 from us leaves the caller's
		// account alive and their Orders data already swept — recoverable only
		// because a retry re-runs Orders as a no-op. Without this branch the 500
		// would carry no *_failed, no reason and no span attribute: the one
		// outcome that most needs to be findable would be the only silent one.
		//
		// The status is unchanged by the branch — the error is reported, not
		// translated.
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
