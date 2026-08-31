package http

import (
	"errors"
	"fmt"
	"log/slog"
	nethttp "net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/attribute"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// readTTL is how long a read stays cached.
//
// SIXTY SECONDS, matching the Python service and the Redis adapter's EntryTTL.
// Short enough that a status change a caller missed by racing an invalidation is
// visible within a minute; long enough to absorb the polling the tracking page
// does while a delivery is in flight.
const readTTL = cache.EntryTTL

// The reason tokens. They go to the LOG and the SPAN only — never into a
// response body. The body carries the prose message the Python's
// HTTPException(detail=…) produced, and adding a `reason` field to it would be a
// new observable contract for a shipped client.
const (
	reasonTooManyOrderIDs  = "too_many_order_ids"
	reasonTrackingNotFound = "not_found"
	reasonMissingOrderIDs  = "missing_order_ids"
	reasonReadFailed       = "read_failed"
)

// orderIDsParam is the batch read's single query parameter.
const orderIDsParam = "order_ids"

// CacheTTLHeader reports the seconds remaining on a cached entry. Stamped on a
// HIT only: a MISS and a BYPASS have no remaining TTL to report, and a header
// carrying 0 would read as "expires now" rather than "unknown".
const CacheTTLHeader = "X-Cache-TTL"

// ReadsHandler serves the two user-scoped reads.
//
// It holds the cache GATEWAY and the enabled FLAG separately, and both are
// needed. The gateway decides what happens (a null gateway does nothing); the
// flag decides whether an X-Cache header is stamped at all. With the cache
// disabled the service must look like one that has no cache — no MISS, no
// BYPASS, no header — because the load test's control arm is exactly that
// comparison.
type ReadsHandler struct {
	get   *app.GetMyTracking
	list  *app.ListMyTrackings
	cache cache.Gateway
	// cacheEnabled mirrors CACHE_ENABLED. See the type doc for why it is not
	// inferred from the gateway.
	cacheEnabled bool
	log          *slog.Logger
}

// NewReadsHandler wires the two use cases and the cache.
func NewReadsHandler(
	get *app.GetMyTracking,
	list *app.ListMyTrackings,
	gateway cache.Gateway,
	cacheEnabled bool,
	log *slog.Logger,
) *ReadsHandler {
	if log == nil {
		log = slog.Default()
	}
	if gateway == nil {
		gateway = cache.NewNullGateway()
	}
	return &ReadsHandler{get: get, list: list, cache: gateway, cacheEnabled: cacheEnabled, log: log}
}

// RegisterReads mounts both routes.
//
// # The batch literal is registered BEFORE the wildcard
//
// Gin builds one radix tree per HTTP METHOD, and both of these live in the GET
// tree. /v1/trackings and /v1/trackings/:order_id do not actually collide — one
// has a trailing segment and the other does not — but the ordering is kept
// explicit because ANY further GET literal under /v1/trackings/ (say
// /v1/trackings/summary) would land in the same tree as the wildcard and PANIC
// THE PROCESS AT STARTUP. Whoever adds one must restructure the prefix, not
// merely append a registration. Starlette matched by declaration order and
// simply never reached a shadowed route, so this failure mode did not exist in
// the Python service.
func RegisterReads(router gin.IRouter, handler *ReadsHandler) {
	router.GET("/v1/trackings", handler.List)
	router.GET("/v1/trackings/:order_id", handler.GetOne)
}

// GetOne serves GET /v1/trackings/{order_id}.
//
// 200 with a FLAT TrackingResponse — not wrapped under "tracking", which is the
// creation route's shape and not this one's.
func (h *ReadsHandler) GetOne(c *gin.Context) {
	// The header carries the caller's Cognito SUB despite its name. EMPTY IS
	// MISSING: nginx sets x-user-id to "" rather than omitting it when the token
	// is absent or malformed, and accepting "" would scope the read to
	// cognito_sub = "" — a silent empty result instead of the 401 the caller
	// deserves.
	cognitoSub := strings.TrimSpace(c.GetHeader(UserIDHeader))
	if cognitoSub == "" {
		c.JSON(nethttp.StatusUnauthorized, FlatError{Detail: "missing x-user-id"})
		return
	}
	orderID := c.Param("order_id")

	key, keyable := cache.TrackingOrderKey(cognitoSub, ResolvedUserID(c), orderID)
	if body, served := h.serveCached(c, key, keyable); served {
		c.Data(nethttp.StatusOK, "application/json; charset=utf-8", body)
		return
	}

	ctx, end := tracing.WorkflowSpan(c.Request.Context(), "get_tracking",
		attribute.String("order_id", orderID))
	var flowErr error
	defer func() { end(flowErr) }()

	// cognitoSub, NEVER ResolvedUserID(c). The internal usr_ id would compare a
	// usr_ id against a column holding a sub and match nothing, answering 404
	// for every caller including the rightful owner.
	found, err := h.get.Execute(ctx, orderID, cognitoSub)
	switch {
	case errors.Is(err, domain.ErrTrackingNotFound):
		// 404, NEVER 403. A 403 would confirm that a tracking exists for this
		// order id and turn the endpoint into an oracle for other people's order
		// ids. "Not yours" and "not there" are one answer here, and the response
		// is byte-identical for both.
		flowErr = err
		tracing.SetSpanAttributes(ctx,
			attribute.String("app_event", "get_tracking_failed"),
			attribute.String("reason", reasonTrackingNotFound))
		h.log.WarnContext(ctx, "get_tracking_failed",
			slog.String("app_event", "get_tracking_failed"),
			slog.String("reason", reasonTrackingNotFound),
			slog.String("order_id", orderID))
		c.JSON(nethttp.StatusNotFound, FlatError{Detail: "tracking not found"})
		return
	case err != nil:
		flowErr = err
		tracing.SetSpanAttributes(ctx,
			attribute.String("app_event", "get_tracking_failed"),
			attribute.String("reason", reasonReadFailed))
		h.log.ErrorContext(ctx, "get_tracking_failed",
			slog.String("app_event", "get_tracking_failed"),
			slog.String("reason", reasonReadFailed),
			slog.String("order_id", orderID),
			slog.String("error", err.Error()))
		c.JSON(nethttp.StatusInternalServerError, FlatError{Detail: "internal server error"})
		return
	}

	// No *_succeeded line. The middleware's `request completed` already carries
	// the route, the status and duration_ms, and these two are the most frequent
	// authenticated calls this service serves — a second line per read would
	// double the stream to say nothing new. Only the failure branches log,
	// because those are the ones the request line cannot explain.
	result := NewTrackingResponse(found)
	h.storeCached(c, key, keyable, result) // reached only on the 200 path
	c.JSON(nethttp.StatusOK, result)
}

// List serves GET /v1/trackings?order_ids=<csv>.
//
// 200 with {"trackings": [...]} — an OBJECT, never a bare array: a bare array
// cannot be extended without breaking every client, and there is deliberately no
// `total`, since a count of what came back would start describing what the
// caller does NOT own.
//
// THERE IS NO 404 ON THIS ROUTE BY DESIGN. Unknown and non-owned ids are
// silently omitted, so a partly-owned request is a 200 with a shorter list.
func (h *ReadsHandler) List(c *gin.Context) {
	cognitoSub := strings.TrimSpace(c.GetHeader(UserIDHeader))
	if cognitoSub == "" {
		c.JSON(nethttp.StatusUnauthorized, FlatError{Detail: "missing x-user-id"})
		return
	}

	// PRESENCE, not emptiness. c.Query returns "" with no error for an absent
	// parameter, so the two cases are indistinguishable through it — and they
	// have DIFFERENT status codes: FastAPI answers 422 for a missing REQUIRED
	// query parameter, while `?order_ids=` is present-but-empty and a perfectly
	// well-defined request for nothing (200 with an empty list).
	raw, present := c.Request.URL.Query()[orderIDsParam]
	if !present || len(raw) == 0 {
		h.log.WarnContext(c.Request.Context(), "list_trackings_failed",
			slog.String("app_event", "list_trackings_failed"),
			slog.String("reason", reasonMissingOrderIDs))
		c.JSON(nethttp.StatusUnprocessableEntity, NewValidationError(
			[]string{"query", orderIDsParam}, "Field required", "missing"))
		return
	}
	parsed := ParseOrderIDs(raw[0])

	ctx, end := tracing.WorkflowSpan(c.Request.Context(), "list_trackings",
		attribute.String("app_event", "list_trackings_started"),
		attribute.Int("requested_count", len(parsed)))
	var flowErr error
	defer func() { end(flowErr) }()

	// The cap counts DISTINCT NON-EMPTY ids, so it is applied AFTER parsing:
	// `?order_ids=a,a,…` repeated 200 times is one id, not a 400.
	if len(parsed) > MaxBatchOrderIDs {
		flowErr = errTooManyOrderIDs
		tracing.SetSpanAttributes(ctx,
			attribute.String("app_event", "list_trackings_failed"),
			attribute.String("reason", reasonTooManyOrderIDs))
		h.log.WarnContext(ctx, "list_trackings_failed",
			slog.String("app_event", "list_trackings_failed"),
			slog.String("reason", reasonTooManyOrderIDs),
			slog.Int("requested_count", len(parsed)),
			slog.Int("max_order_ids", MaxBatchOrderIDs))
		// Shape A — the prose message only. reasonTooManyOrderIDs stays on the
		// log and the span.
		c.JSON(nethttp.StatusBadRequest, FlatError{
			Detail: fmt.Sprintf("at most %d order_ids per request", MaxBatchOrderIDs),
		})
		return
	}

	key, keyable := cache.TrackingListKey(cognitoSub, ResolvedUserID(c), parsed)
	if body, served := h.serveCached(c, key, keyable); served {
		c.Data(nethttp.StatusOK, "application/json; charset=utf-8", body)
		return
	}

	// An empty id list never reaches the database: the use case short-circuits,
	// because sqlc's IN (sqlc.slice()) — and a hand-built IN () alike — is
	// invalid SQL for an empty slice.
	found, err := h.list.Execute(ctx, parsed, cognitoSub)
	if err != nil {
		flowErr = err
		tracing.SetSpanAttributes(ctx,
			attribute.String("app_event", "list_trackings_failed"),
			attribute.String("reason", reasonReadFailed))
		h.log.ErrorContext(ctx, "list_trackings_failed",
			slog.String("app_event", "list_trackings_failed"),
			slog.String("reason", reasonReadFailed),
			slog.Int("requested_count", len(parsed)),
			slog.String("error", err.Error()))
		c.JSON(nethttp.StatusInternalServerError, FlatError{Detail: "internal server error"})
		return
	}

	// Non-nil slice, so an empty result marshals as [] and NEVER as null.
	items := make([]TrackingResponse, 0, len(found))
	for _, item := range found {
		items = append(items, NewTrackingResponse(item))
	}
	result := TrackingListResponse{Trackings: items}

	tracing.SetSpanAttributes(ctx,
		attribute.String("app_event", "list_trackings_succeeded"),
		attribute.Int("found_count", len(items)))

	h.storeCached(c, key, keyable, result)
	c.JSON(nethttp.StatusOK, result)
}

// errTooManyOrderIDs marks the span as failed for an over-cap request. Declared
// beside the handler that produces it; it is never returned to a caller.
var errTooManyOrderIDs = errors.New("at most 100 order_ids per request")

// serveCached looks the entry up and stamps X-Cache.
//
// Returns the raw cached bytes and true when the response was served from the
// cache. The bytes are replayed VERBATIM rather than decoded and re-encoded: a
// round trip through a Go struct would silently normalise anything the stored
// shape had that the current struct does not, which is precisely the drift the
// key's version segment exists to make visible.
//
// # With the cache disabled, NOTHING is stamped
//
// Not MISS, not BYPASS — no header at all. The load test's control arm must look
// like a service with no cache, and a MISS on every request is a service with a
// cache that never hits, which is a different measurement.
//
// An unkeyable request (no resolved usr_ id) is a MISS with no lookup: it is
// served from the database and cached neither way.
func (h *ReadsHandler) serveCached(c *gin.Context, key string, keyable bool) ([]byte, bool) {
	if !h.cacheEnabled {
		return nil, false
	}
	if !keyable {
		c.Header(CacheHeader, cache.HeaderMiss)
		return nil, false
	}

	entry := h.cache.Get(c.Request.Context(), key)
	switch {
	case entry.Hit:
		c.Header(CacheHeader, cache.HeaderHit)
		if entry.TTLRemaining > 0 {
			// Omitted when unknown: Redis answers -1 for a key with no expiry
			// and -2 for one that is gone, and the gateway maps both to 0. A
			// header carrying 0 would read as "expires now".
			c.Header(CacheTTLHeader, strconv.Itoa(entry.TTLRemaining))
		}
		return entry.Value, true
	case entry.Bypassed:
		// Redis did not answer. Kept DISTINCT from MISS so an outage does not
		// read as a poor hit rate on the dashboard — the one reading that would
		// send an operator to look at the wrong system.
		c.Header(CacheHeader, cache.HeaderBypass)
	default:
		c.Header(CacheHeader, cache.HeaderMiss)
	}
	return nil, false
}

// storeCached writes the freshly-computed response.
//
// # A non-200 can never reach this
//
// It is called only after a handler has produced its success value, on the same
// straight-line path as the 200. That is structural: every failure branch
// returns before it, so a 404, a 400, a 401 and a 422 cannot be cached even by a
// future edit that forgets a status check — because there is no status check to
// forget.
//
// The index key ties this entry to the user, so the account-deletion cascade and
// the carrier webhook can evict it without reconstructing the list key's hash.
func (h *ReadsHandler) storeCached(c *gin.Context, key string, keyable bool, value any) {
	if !h.cacheEnabled || !keyable {
		return
	}
	// The write must not be attributed to a cancelled context: the response is
	// about to be sent, but Set runs inline and finishes first, so the request
	// context is still live here. Anything moved off-request later must derive
	// from the process lifetime context instead.
	h.cache.Set(c.Request.Context(), key, value, readTTL,
		cache.UserIndexKey(strings.TrimSpace(c.GetHeader(UserIDHeader)), ResolvedUserID(c)))
}
