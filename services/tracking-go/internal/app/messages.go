package app

import (
	"encoding/json"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// The bus messages: one type per use case, plain data with no behavior.
//
// CONTRACT: A message carries NO transport. No gin.Context, no headers, no
// *http.Request — the pipeline behind these is shared with the TestMode
// progression, which has no request at all. A field that needed a request would
// make the bus unreachable from that caller.
//
// WARNING: ShippingAddress on CreateTracking is PII and is never logged and never
// traced. The Fields and Attributes extractors on each flow are what enforce that,
// by naming the safe fields explicitly rather than reflecting over the message.
// See [[logging-context]]

// GetMyTrackingQuery reads one of the caller's own trackings.
//
// CONTRACT: CognitoSub, never an internal usr_ id. x-user-id carries the JWT sub
// despite its name, and scoping by user_id answers 404 for every caller including
// the owner while looking implemented.
// See [[user-id-vs-cognito-sub-ownership-key]]
type GetMyTrackingQuery struct {
	OrderID    string
	CognitoSub string
}

// ListMyTrackingsQuery reads the caller's trackings among OrderIDs.
type ListMyTrackingsQuery struct {
	OrderIDs   []string
	CognitoSub string
}

// CreateTrackingCommand opens a tracking at PLACED with its first history row.
type CreateTrackingCommand struct {
	OrderID     string
	OrderNumber string
	CognitoSub  string
	// ShippingAddress is stored byte-for-byte and never inspected. PII: never
	// logged, never a span attribute.
	ShippingAddress json.RawMessage
	E2ESource       bool
	E2ERunTag       string
	// TestMode is observability-only: the use case ignores it, and the caller
	// decides separately whether to start the accelerated progression. It travels
	// on the message so it reaches the flow's success line, which is where it was
	// always logged — a second log line to carry one boolean would double this
	// flow's stream.
	TestMode bool
}

// UpdateStatusCommand advances one tracking, from the carrier webhook or from the
// TestMode progression.
//
// CONTRACT: Actor is a FIELD and never a constant the handler picks. Hardcoding it
// would relabel every automatic progression as a carrier update, and the two are
// only distinguishable because this value travels. See [[audit-fields]]
type UpdateStatusCommand struct {
	OrderID   string
	Requested domain.Status
	Actor     audit.Actor
}

// DeleteByUserCommand is the account-deletion cascade's tracking leg.
//
// CONTRACT: BOTH identities travel and the predicate matches EITHER. Rows
// predating the cognito_sub migration carry only user_id, and cognito_sub is not
// durable — a user who re-registers gets a new one while their usr_ id never
// changes. See [[soft-delete]]
type DeleteByUserCommand struct {
	CognitoSub string
	UserID     string
}

// E2ECleanupCommand soft-deletes the E2E fixtures for one run.
//
// RunTag is "" for an unscoped teardown, which is a legal request and not a
// missing value: the harness may sweep every fixture rather than one run's.
type E2ECleanupCommand struct {
	RunTag string
}
