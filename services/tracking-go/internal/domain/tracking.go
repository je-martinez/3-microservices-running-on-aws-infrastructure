package domain

import (
	"errors"
	"sort"
	"time"
)

// Column widths, as domain constants so nothing restates a literal.
const (
	// CONTRACT: IDLength is prefix (4) + random portion (24), and getting it
	// wrong does not error — MySQL TRUNCATES silently, so a narrow column
	// stores a shortened id that still looks like one and matches no row.
	// See [[nano-id]]
	IDLength = 28

	// StatusLength is the declared width of the status column.
	StatusLength = 50

	// CognitoSubLength matches Orders' order.cognito_sub. A Cognito sub is a
	// 36-char UUID today, but the two MySQL services storing the same value
	// under the same name must not disagree on its width.
	CognitoSubLength = 255
)

// E2ESourceTag marks a tracking as an E2E fixture and is the exact string
// DELETE /v1/trackings/e2e-cleanup selects on.
//
// CONTRACT: Shared with Users VERBATIM — space, capitals and all. A near-miss
// ("e2e-source") cleans up nothing while looking correct. It lives in the domain
// because it is persisted on a row, so the transport-free layer needs it.
const E2ESourceTag = "E2E Source"

// Tracking is one tracking record — one per order.
//
// A pure domain type. It is deliberately NOT reused as an HTTP response type:
// ShippingAddress and CognitoSub appear on no response, and a response struct
// must be physically incapable of holding them.
type Tracking struct {
	// ID is the prefixed nano-ID (trk_...). Primary key.
	ID string

	// UserID is the INTERNAL usr_ id, as Orders resolved it from Users. Stored
	// for reporting and cross-service joins. NOT the key user-scoped reads
	// filter by — see CognitoSub.
	UserID string

	// CONTRACT: CognitoSub is THE OWNERSHIP KEY for the REST reads, injected by
	// the gateway as x-user-id. Scoping by UserID compares a sub against a usr_
	// id, which never matches, so every read 404s — the caller's own tracking
	// included — while looking implemented. "" means absent (NULL), and such a
	// row is unreachable rather than mis-attributed.
	// See [[user-id-vs-cognito-sub-ownership-key]]
	CognitoSub string

	// OrderID is UNIQUE — one tracking per order, enforced at the database so a
	// duplicate creation cannot race past a pre-check.
	OrderID string

	// TrackingNumber is the customer-facing 3MRAI-XXXX-XXXX-XXXX number. OURS,
	// not a carrier's: the row exists from PLACED onward, long before anything
	// is handed to a shipper.
	TrackingNumber string

	// Status is one of the five Status values.
	Status Status

	// WARNING: PII. Never log it.
	//
	// CONTRACT: []byte, never a parsed struct — Orders/Users own the shape, and
	// a strict model turns an additive upstream field into a creation outage.
	// nil when absent. See [[logging-context]]
	ShippingAddress []byte

	// Tags are free-form labels. Today exactly one value is ever written:
	// E2ESourceTag. Never nil in the database (NOT NULL, default JSON_ARRAY()).
	Tags []string

	// Datetime is the timestamp of the CURRENT status. Distinct from UpdatedAt:
	// this moves only on a status transition, UpdatedAt moves on any write.
	Datetime time.Time

	CreatedBy string
	CreatedAt time.Time
	UpdatedBy string
	UpdatedAt time.Time
	DeletedBy string

	// DeletedAt is nil when the row is live. Soft delete: the application never
	// issues DELETE, and the DB user has no DELETE grant.
	DeletedAt *time.Time

	// History is ordered by SortHistory. Never trust the order rows arrive in.
	History []TrackingHistory
}

// TrackingHistory is one status transition of a tracking. No surrogate id, no
// tags, no shipping address — the address is fixed for a tracking's lifetime.
//
// CONTRACT: Its (TrackingID, Status) primary key is a SECOND enforcement of the
// forward-only machine — one row per status, so a duplicate transition fails at
// INSERT even when an application guard is bypassed.
type TrackingHistory struct {
	TrackingID string
	Status     Status
	UserID     string
	OrderID    string
	CognitoSub string
	Datetime   time.Time
	CreatedBy  string
	CreatedAt  time.Time
	UpdatedBy  string
	UpdatedAt  time.Time
	DeletedBy  string
	DeletedAt  *time.Time
}

// CONTRACT: The audit Actor lives in internal/domain/audit, and every use case
// takes it as a parameter and threads it through. It is NEVER a constant a
// publisher or repository picks for itself — that relabels every automatic
// progression as a carrier update. See [[audit-fields]]

// Sentinel errors. Declared here, beside the types that produce them, rather
// than in a shared errors package — the adapters map them to status codes with
// errors.Is, so the mapping lives at the boundary and the domain stays unaware
// of HTTP.
var (
	// ErrTrackingNotFound means no LIVE tracking matched. On the user-scoped
	// reads it deliberately also covers "exists but belongs to someone else":
	// the two are indistinguishable to the caller by design, so the endpoint
	// cannot be used as an oracle for other people's order ids. Maps to 404.
	ErrTrackingNotFound = errors.New("tracking not found")

	// ErrTrackingAlreadyExists means the order already has a tracking or any
	// history. Maps to 409, so a retry cannot duplicate a shipment.
	ErrTrackingAlreadyExists = errors.New("tracking already exists")

	// ErrUserNotFound means Users answered NOT_FOUND for the caller's sub.
	// Maps to 404 with reason "unknown_user". It must NOT be returned for any
	// other gRPC failure: a Users outage is a 500, never "this user does not
	// exist".
	ErrUserNotFound = errors.New("user not found")
)

// NewTracking is the input to creation: the caller-supplied facts, before the
// service mints the id, the tracking number, the initial status and the audit
// stamps. Keeping it separate from Tracking is what stops a caller supplying
// an id or a status of its own choosing.
type NewTracking struct {
	OrderID string

	// UserID is the internal usr_ id, already resolved from the caller's sub.
	UserID string

	// CognitoSub is the caller's sub — the ownership key. "" is stored as NULL.
	CognitoSub string

	// ShippingAddress stays opaque JSON, never a struct: Orders owns the shape
	// and a strict type turns an additive upstream field into a creation
	// outage. nil means the column is NULL.
	ShippingAddress []byte

	// Tags carries E2ESourceTag only when the request sent x-e2e-source AND
	// E2E_TESTING_ENABLED is on.
	//
	// CONTRACT: []string, NOT mysql.Tags. That is an adapter type carrying the
	// driver Scanner/Valuer, and this package imports only the standard library.
	// The adapter converts at its boundary. See [[screaming-architecture]]
	Tags []string
}

// TrackingWithHistory is a tracking with its ordered history — the unit every
// read and write path returns. History is already sorted by SortHistory.
//
// CONTRACT: Keep this a plain composition, never an embedding — promoting the
// parent's PII-bearing fields lets a handler marshal them onto a response.
// See [[logging-context]]
//
// CONTRACT: Rebuild this from a fresh read after appending a history row —
// reusing a value loaded before the append publishes an event that omits the
// transition it announces. See [[events-pipeline-design]]
type TrackingWithHistory struct {
	Tracking Tracking
	History  []TrackingHistory
}

// SortHistory orders history by transition time, then progression position.
//
// CONTRACT: Keep the progression tiebreaker. A bare datetime sort is not
// deterministic — DATETIME fsp 0 and one `now` per unit of work make ties
// routine, and on a tie MySQL may use the (tracking_id, status) key, which sorts
// alphabetically and puts DELIVERED first. SliceStable, so equal keys hold.
func SortHistory(history []TrackingHistory) {
	sort.SliceStable(history, func(i, j int) bool {
		if !history[i].Datetime.Equal(history[j].Datetime) {
			return history[i].Datetime.Before(history[j].Datetime)
		}
		// Timestamps tie: fall back to progression position, NEVER to the status
		// string (which would sort DELIVERED first).
		iIndex, iOK := StatusIndex(history[i].Status)
		jIndex, jOK := StatusIndex(history[j].Status)
		// An unrecognized status sorts last rather than crashing the read path.
		if !iOK || !jOK {
			return iOK && !jOK
		}
		return iIndex < jIndex
	})
}

// IsDeleted reports whether the tracking has been soft-deleted.
func (t *Tracking) IsDeleted() bool {
	return t.DeletedAt != nil
}

// HasTag reports whether the tracking carries tag. Matching is exact and
// case-sensitive — see E2ESourceTag.
func (t *Tracking) HasTag(tag string) bool {
	for _, candidate := range t.Tags {
		if candidate == tag {
			return true
		}
	}
	return false
}
