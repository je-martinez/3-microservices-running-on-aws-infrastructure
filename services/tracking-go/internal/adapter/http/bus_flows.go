package http

import (
	"context"
	"errors"
	"log/slog"

	"go.opentelemetry.io/otel/attribute"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/bus"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// CONTRACT: Declare flows HERE, never in internal/app. That package imports only
// internal/domain, and the behaviors need otel and slog — a flow in a use case's
// own file inverts the hexagon and makes internal/app's tests need a tracer
// provider. See [[screaming-architecture]]

// CONTRACT: Fields and Attributes NAME the safe values; do NOT reflect over a
// message. CreateTrackingCommand carries shipping_address, so a reflective
// extractor puts PII on every line and span of the creation flow.
// See [[logging-context]]

// routineReads maps the reads' one routine outcome.
//
// A tracking that is absent or owned by somebody else is the SAME return value by
// design, and the route turns it into a 404. It is a normal answer, not a fault:
// the span status stays unset while the log still carries `*_failed` and `reason`.
// See [[user-id-vs-cognito-sub-ownership-key]]
func routineReads(err error) error {
	if errors.Is(err, domain.ErrTrackingNotFound) {
		return bus.Routine(err, reasonTrackingNotFound)
	}
	return err
}

// GetMyTrackingFlow describes the single read.
func GetMyTrackingFlow() bus.Flow[app.GetMyTrackingQuery, domain.TrackingWithHistory] {
	return bus.Flow[app.GetMyTrackingQuery, domain.TrackingWithHistory]{
		Name:        "get_tracking",
		FaultReason: reasonReadFailed,
		// FAILURES ONLY. The middleware's `request completed` already carries the
		// route, the status and duration_ms, and the two reads are the most
		// frequent authenticated calls this service serves — a second line per
		// read would double the stream to say nothing new.
		Lines: &bus.Lines{Started: false, Succeeded: false},
		Fields: func(q app.GetMyTrackingQuery) []slog.Attr {
			return []slog.Attr{slog.String("order_id", q.OrderID)}
		},
		Attributes: func(q app.GetMyTrackingQuery) []attribute.KeyValue {
			return []attribute.KeyValue{attribute.String("order_id", q.OrderID)}
		},
	}
}

// ListMyTrackingsFlow describes the batch read.
//
// requested_count is a SPAN attribute and not a log field: the shared log context
// is a fixed allow-list of seven keys, and a count is not one of them.
// See [[logging-context]]
func ListMyTrackingsFlow() bus.Flow[app.ListMyTrackingsQuery, []domain.TrackingWithHistory] {
	return bus.Flow[app.ListMyTrackingsQuery, []domain.TrackingWithHistory]{
		Name:        "list_trackings",
		FaultReason: reasonReadFailed,
		// Failures only, for the same reason as the single read.
		Lines:  &bus.Lines{Started: false, Succeeded: false},
		Fields: func(app.ListMyTrackingsQuery) []slog.Attr { return nil },
		Attributes: func(q app.ListMyTrackingsQuery) []attribute.KeyValue {
			return []attribute.KeyValue{attribute.Int("requested_count", len(q.OrderIDs))}
		},
		ResultAttributes: func(found []domain.TrackingWithHistory) []attribute.KeyValue {
			return []attribute.KeyValue{attribute.Int("found_count", len(found))}
		},
		Validate: func(q app.ListMyTrackingsQuery) error {
			// The cap counts DISTINCT NON-EMPTY ids, so the caller parses first and
			// this sees the parsed slice: `?order_ids=a,a,…` repeated 200 times is
			// one id, not a rejection.
			if len(q.OrderIDs) > MaxBatchOrderIDs {
				return bus.Routine(errTooManyOrderIDs, reasonTooManyOrderIDs)
			}
			return nil
		},
	}
}

// CreateTrackingFlow describes creation.
//
// WARNING: No shipping_address, in Fields or Attributes. It is PII, and the
// creation message is the one that carries it.
func CreateTrackingFlow() bus.Flow[app.CreateTrackingCommand, domain.TrackingWithHistory] {
	return bus.Flow[app.CreateTrackingCommand, domain.TrackingWithHistory]{
		Name:        "init_tracking",
		FaultReason: reasonInternalError,
		Fields: func(q app.CreateTrackingCommand) []slog.Attr {
			return []slog.Attr{
				slog.String("order_id", q.OrderID),
				slog.String("cognito_sub", q.CognitoSub),
				slog.Bool("test_mode", q.TestMode),
			}
		},
		Attributes: func(q app.CreateTrackingCommand) []attribute.KeyValue {
			return []attribute.KeyValue{
				attribute.String("order_id", q.OrderID),
				attribute.Bool("test_mode", q.TestMode),
			}
		},
		// Both come off the PERSISTED row rather than the request: the usr_ id was
		// resolved by the use case, and the tracking id was minted by it.
		ResultFields: func(created domain.TrackingWithHistory) []slog.Attr {
			return []slog.Attr{
				slog.String("tracking_id", created.Tracking.ID),
				slog.String("user_id", created.Tracking.UserID),
			}
		},
		ResultAttributes: func(created domain.TrackingWithHistory) []attribute.KeyValue {
			return []attribute.KeyValue{
				attribute.String("tracking_id", created.Tracking.ID),
				attribute.String("user_id", created.Tracking.UserID),
			}
		},
	}
}

// UpdateStatusFlow describes the transition behind BOTH the carrier webhook and
// the TestMode progression.
//
// No cognito_sub and no user_id: the carrier callback carries no caller identity
// at all, and unknown fields are OMITTED rather than logged as null.
func UpdateStatusFlow() bus.Flow[app.UpdateStatusCommand, domain.TrackingWithHistory] {
	return bus.Flow[app.UpdateStatusCommand, domain.TrackingWithHistory]{
		Name:        "carrier_status_update",
		FaultReason: reasonInternalError,
		Fields: func(q app.UpdateStatusCommand) []slog.Attr {
			return []slog.Attr{slog.String("order_id", q.OrderID)}
		},
		Attributes: func(q app.UpdateStatusCommand) []attribute.KeyValue {
			return []attribute.KeyValue{attribute.String("order_id", q.OrderID)}
		},
		ResultFields: func(updated domain.TrackingWithHistory) []slog.Attr {
			return []slog.Attr{
				slog.String("tracking_id", updated.Tracking.ID),
				slog.String("status", string(updated.Tracking.Status)),
			}
		},
		ResultAttributes: func(updated domain.TrackingWithHistory) []attribute.KeyValue {
			return []attribute.KeyValue{
				attribute.String("tracking_id", updated.Tracking.ID),
				attribute.String("status", string(updated.Tracking.Status)),
			}
		},
	}
}

// DeleteByUserFlow describes the cascade leg.
func DeleteByUserFlow() bus.Flow[app.DeleteByUserCommand, int64] {
	return bus.Flow[app.DeleteByUserCommand, int64]{
		Name:        "internal_delete_by_user",
		FaultReason: reasonDBError,
		// BOTH lines. Users calls every cascade leg before touching the account, so
		// a crash here leaves the account alive with Orders already swept, and the
		// `_started` line is what shows how far the cascade got.
		Lines: &bus.Lines{Started: true, Succeeded: true},
		Fields: func(q app.DeleteByUserCommand) []slog.Attr {
			return []slog.Attr{
				slog.String("cognito_sub", q.CognitoSub),
				slog.String("user_id", q.UserID),
			}
		},
		Attributes: func(q app.DeleteByUserCommand) []attribute.KeyValue {
			return []attribute.KeyValue{
				attribute.String("cognito_sub", q.CognitoSub),
				attribute.String("user_id", q.UserID),
			}
		},
		ResultFields: func(deleted int64) []slog.Attr {
			return []slog.Attr{slog.Int64("deleted_count", deleted)}
		},
		ResultAttributes: func(deleted int64) []attribute.KeyValue {
			return []attribute.KeyValue{attribute.Int64("deleted_count", deleted)}
		},
	}
}

// E2ECleanupFlow describes the teardown.
func E2ECleanupFlow() bus.Flow[app.E2ECleanupCommand, int64] {
	return bus.Flow[app.E2ECleanupCommand, int64]{
		Name:        "e2e_cleanup",
		FaultReason: reasonDBError,
		Fields:      func(app.E2ECleanupCommand) []slog.Attr { return nil },
		Attributes:  func(app.E2ECleanupCommand) []attribute.KeyValue { return nil },
		// {"deleted": 0} is a SUCCESS, and the count is what makes a teardown
		// diagnosable — "the suite still sees its fixtures" and "the cleanup matched
		// nothing" are one symptom from the harness's side.
		ResultFields: func(deleted int64) []slog.Attr {
			return []slog.Attr{slog.Int64("deleted_count", deleted)}
		},
		ResultAttributes: func(deleted int64) []attribute.KeyValue {
			return []attribute.KeyValue{attribute.Int64("deleted_count", deleted)}
		},
	}
}

// ─── the wrapped handlers ───────────────────────────────────────────────────
//
// One builder per use case. Each adapts the use case's own Execute signature to
// bus.Handler[Q, R] and wraps it in the D4 pipeline, so the HTTP handler receives
// a function and carries no cross-cutting concern of its own.

// WrapGetMyTracking builds the single read's dispatch function.
func WrapGetMyTracking(
	uc *app.GetMyTracking, log *slog.Logger,
) bus.Handler[app.GetMyTrackingQuery, domain.TrackingWithHistory] {
	return bus.Pipeline(
		func(ctx context.Context, q app.GetMyTrackingQuery) (domain.TrackingWithHistory, error) {
			found, err := uc.Execute(ctx, q.OrderID, q.CognitoSub)
			return found, routineReads(err)
		},
		GetMyTrackingFlow(), log)
}

// WrapListMyTrackings builds the batch read's dispatch function.
func WrapListMyTrackings(
	uc *app.ListMyTrackings, log *slog.Logger,
) bus.Handler[app.ListMyTrackingsQuery, []domain.TrackingWithHistory] {
	return bus.Pipeline(
		func(ctx context.Context, q app.ListMyTrackingsQuery) ([]domain.TrackingWithHistory, error) {
			return uc.Execute(ctx, q.OrderIDs, q.CognitoSub)
		},
		ListMyTrackingsFlow(), log)
}

// WrapCreateTracking builds creation's dispatch function.
//
// Both of its failure modes are ROUTINE: an unknown user is a 404 the same valid
// token will produce forever, and an existing tracking is a 409 that keeps a lost
// race from duplicating a shipment. Neither is a fault, so neither marks the span
// ERROR.
func WrapCreateTracking(
	uc *app.CreateTracking, log *slog.Logger,
) bus.Handler[app.CreateTrackingCommand, domain.TrackingWithHistory] {
	return bus.Pipeline(
		func(ctx context.Context, q app.CreateTrackingCommand) (domain.TrackingWithHistory, error) {
			created, err := uc.Execute(ctx, app.CreateTrackingInput{
				OrderID:         q.OrderID,
				OrderNumber:     q.OrderNumber,
				CognitoSub:      q.CognitoSub,
				ShippingAddress: q.ShippingAddress,
				E2ESource:       q.E2ESource,
				E2ERunTag:       q.E2ERunTag,
			})
			switch {
			case errors.Is(err, app.ErrUnknownUser):
				return created, bus.Routine(err, reasonUnknownUser)
			case errors.Is(err, domain.ErrTrackingAlreadyExists):
				return created, bus.Routine(err, reasonAlreadyExists)
			}
			return created, err
		},
		CreateTrackingFlow(), log)
}

// WrapUpdateStatus builds the transition's dispatch function.
//
// The state machine's rejections keep their OWN reasons — already_delivered,
// backward_transition, not_strictly_forward — because the guard order is
// load-bearing and the reason is how a carrier integrator learns which guard
// refused. A single generic token here would erase that.
func WrapUpdateStatus(
	uc StatusTransitioner, log *slog.Logger,
) bus.Handler[app.UpdateStatusCommand, domain.TrackingWithHistory] {
	return bus.Pipeline(
		func(ctx context.Context, q app.UpdateStatusCommand) (domain.TrackingWithHistory, error) {
			updated, err := uc.Execute(ctx, q.OrderID, q.Requested, q.Actor)
			if errors.Is(err, domain.ErrTrackingNotFound) {
				return updated, bus.Routine(err, reasonTrackingNotFound)
			}
			var invalid *domain.InvalidTransitionError
			if errors.As(err, &invalid) {
				return updated, bus.Routine(err, string(invalid.Reason))
			}
			return updated, err
		},
		UpdateStatusFlow(), log)
}

// WrapDeleteByUser builds the cascade leg's dispatch function.
//
// ErrEmptyIdentity is ROUTINE: the route already rejects empty identities at
// decode time, so reaching it is a 422 rather than the db_error a bare error would
// report.
func WrapDeleteByUser(
	uc *app.DeleteByUser, log *slog.Logger,
) bus.Handler[app.DeleteByUserCommand, int64] {
	return bus.Pipeline(
		func(ctx context.Context, q app.DeleteByUserCommand) (int64, error) {
			deleted, err := uc.Execute(ctx, q.CognitoSub, q.UserID)
			if errors.Is(err, app.ErrEmptyIdentity) {
				return deleted, bus.Routine(err, reasonEmptyIdentity)
			}
			return deleted, err
		},
		DeleteByUserFlow(), log)
}

// WrapE2ECleanup builds the teardown's dispatch function.
func WrapE2ECleanup(
	uc *app.E2ECleanup, log *slog.Logger,
) bus.Handler[app.E2ECleanupCommand, int64] {
	return bus.Pipeline(
		func(ctx context.Context, q app.E2ECleanupCommand) (int64, error) {
			return uc.ExecuteScoped(ctx, q.RunTag)
		},
		E2ECleanupFlow(), log)
}
