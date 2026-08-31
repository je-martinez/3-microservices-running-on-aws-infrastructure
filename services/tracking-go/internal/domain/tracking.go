package domain

import (
	"errors"
	"sort"
	"time"
)

// Column widths, as domain constants so nothing restates a literal.
const (
	// IDLength is the width of every id-bearing column: prefix (4) + random
	// portion (24). Task 5 adds a compile-time assertion tying this to the
	// generator's own constants.
	//
	// Getting this wrong does not error. MySQL TRUNCATES an over-long value
	// silently, so a column narrower than the generator produces stores a
	// shortened id that still looks like an id and merely stops matching the row
	// it was supposed to identify.
	IDLength = 28

	// StatusLength is the declared width of the status column.
	StatusLength = 50

	// CognitoSubLength matches Orders' order.cognito_sub. A Cognito sub is a
	// 36-char UUID today, but the two MySQL services storing the same value
	// under the same name must not disagree on its width.
	CognitoSubLength = 255
)

// E2ESourceTag is the only tag value this service ever writes: the label marking
// a tracking as an E2E fixture, and the exact string
// DELETE /v1/trackings/e2e-cleanup selects on.
//
// Shared with Users VERBATIM — space, capitals and all — because both services'
// teardowns select on this same literal, and a near-miss ("e2e-source") would
// clean up nothing while looking perfectly correct.
//
// It lives in the domain rather than beside the HTTP header that requests it:
// the tag is a value persisted on a row, so the transport-free use-case layer
// needs it and must not import an HTTP module to get it.
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

	// CognitoSub is the owner's Cognito sub, and THE OWNERSHIP KEY for the REST
	// reads. The gateway injects it as the x-user-id header. Scoping a read by
	// UserID instead would compare a sub against a usr_ id, which never matches,
	// so every user-scoped read would answer 404 — including for the caller's
	// own tracking — while looking perfectly implemented.
	//
	// "" means absent (the column is NULL). Such a row is unreachable over the
	// user-scoped reads, never mis-attributed: NULL matches no caller's sub.
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

	// ShippingAddress is the point-in-time address snapshot forwarded as-is by
	// Orders, held as RAW JSON.
	//
	// Deliberately []byte and NOT a parsed Go struct. The shape is owned by
	// Orders/Users; this service only stores and returns it, never inspects it.
	// A strict model would turn an additive upstream field into a creation
	// outage. nil when absent.
	//
	// PII — never log it.
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

// TrackingHistory is one status transition of a tracking.
//
// It deliberately has NO surrogate id, NO tags, and NO shipping address. The
// address is fixed for a tracking's lifetime, so snapshotting it per transition
// would store identical JSON five times. Its composite primary key
// (TrackingID, Status) is a SECOND enforcement of the forward-only state
// machine: at most one row per status, so a duplicate transition fails at INSERT
// even if an application guard is bypassed.
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

// NOTE: the audit Actor type and its five constants are NOT declared here. They
// live in the sibling package `internal/domain/audit` (Task 17) — still inside
// the domain, since "what produced this row" is a business fact, not transport.
// Every use case takes an audit.Actor parameter and threads it through; it is
// NEVER a constant the publisher or the repository picks for itself.

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

	// ShippingAddress stays opaque JSON, never a struct: the shape is owned by
	// Orders (originally Users' Address message) and this service only stores
	// it. A strict type here would turn an additive upstream field into a
	// creation outage. nil means the column is NULL.
	ShippingAddress []byte

	// Tags carries E2ESourceTag when, and only when, the request sent
	// x-e2e-source: true AND E2E_TESTING_ENABLED is on.
	//
	// []string, NOT the mysql.Tags named type. mysql.Tags is an ADAPTER type
	// (it carries the sql/driver Scanner and Valuer for the JSON column), and
	// this package may import only the standard library. Naming it here would
	// make the domain depend on the persistence layer — precisely the coupling
	// the purity rule exists to prevent. The adapter converts at its boundary.
	Tags []string
}

// TrackingWithHistory is a tracking together with its ordered history.
//
// This is the unit every read and every write path returns, because BOTH REST
// reads answer with the tracking AND its history, and the SQS event embeds the
// history too. Keeping them in one value is what stops a caller assembling the
// pair itself and getting the ordering wrong — History is expected to already
// be sorted by SortHistory when this value is built.
//
// It is a plain composition, not an embedding: Tracking is a field rather than
// an anonymous member, so a handler cannot accidentally marshal the parent's
// PII-bearing fields by promoting them onto a response type. Response structs
// are built explicitly from this value; they never embed it.
//
// After a write that appends a history row, this value MUST be rebuilt from a
// fresh read. Reusing a TrackingWithHistory loaded before the append publishes
// an event that omits the very transition it announces — the Python service
// expires that collection explicitly for this reason.
type TrackingWithHistory struct {
	Tracking Tracking
	History  []TrackingHistory
}

// SortHistory orders history in place by transition time, then by progression
// position.
//
// THE TIEBREAKER IS LOAD-BEARING, not decoration. A bare datetime sort is NOT
// deterministic here, and this bit the Python service in a real test against
// real MySQL:
//
// Two transitions can share a datetime. The column is DATETIME with fsp 0, i.e.
// SECOND resolution; a carrier can send two updates inside the same second, and
// any code path writing several transitions in one unit of work stamps them all
// from one `now`. When the timestamps tie, MySQL is free to return rows in
// primary-key order, and the PK is (tracking_id, status) — so the tie resolves
// ALPHABETICALLY: DELIVERED, OUT_FOR_DELIVERY, PLACED, PROCESSING, SHIPPED. The
// terminal status first, meaning a caller would see a shipment delivered before
// it was ever placed.
//
// Mapping each status to its index in the forward-only progression resolves ties
// into the only order that can be correct.
//
// sort.SliceStable, not sort.Slice: with both keys equal (the same status at the
// same instant, which the composite PK makes impossible in the database but
// which an in-memory caller could construct) the input order is preserved rather
// than scrambled.
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
