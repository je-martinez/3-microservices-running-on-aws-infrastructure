package http_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// ─── doubles ────────────────────────────────────────────────────────────────
//
// The two identity values below are DIFFERENT strings on purpose. A double that
// stored one value for both user_id and cognito_sub could not fail on the
// ownership bug — the read would match either way.

const (
	// readsRowUserID is the INTERNAL usr_ id stored on the row.
	readsRowUserID = "usr_internal_abc"
	// readsOwnerSub is the JWT sub the gateway injects as x-user-id.
	readsOwnerSub = "sub-owner"
)

// fakeReadsRepo answers both scoped reads. Its ownership predicate compares against
// CognitoSub only, exactly as the SQL does.
type fakeReadsRepo struct {
	mu sync.Mutex
	// owned maps order_id -> owning cognito_sub.
	owned map[string]string

	getCalls  int
	listCalls int
	// scopedBy records the identity each call was scoped by.
	scopedBy []string
}

func (r *fakeReadsRepo) row(orderID, ownerCognitoSub string) domain.TrackingWithHistory {
	moment := time.Date(2026, 8, 27, 14, 53, 1, 0, time.UTC)
	return domain.TrackingWithHistory{
		Tracking: domain.Tracking{
			ID:              "trk_" + orderID,
			UserID:          readsRowUserID,
			CognitoSub:      ownerCognitoSub,
			OrderID:         orderID,
			TrackingNumber:  "3MRAI-0000-0000-0001",
			Status:          domain.StatusPlaced,
			ShippingAddress: []byte(`{"line1":"1 Main St"}`),
			Datetime:        moment,
		},
		History: []domain.TrackingHistory{{
			TrackingID: "trk_" + orderID,
			Status:     domain.StatusPlaced,
			UserID:     readsRowUserID,
			OrderID:    orderID,
			CognitoSub: ownerCognitoSub,
			Datetime:   moment,
		}},
	}
}

func (r *fakeReadsRepo) GetByOrderIDScoped(_ context.Context, orderID, cognitoSub string) (domain.TrackingWithHistory, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.getCalls++
	r.scopedBy = append(r.scopedBy, cognitoSub)

	owner, exists := r.owned[orderID]
	if !exists || owner != cognitoSub {
		return domain.TrackingWithHistory{}, domain.ErrTrackingNotFound
	}
	return r.row(orderID, owner), nil
}

func (r *fakeReadsRepo) ListByOrderIDsScoped(_ context.Context, orderIDs []string, cognitoSub string) ([]domain.TrackingWithHistory, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.listCalls++
	r.scopedBy = append(r.scopedBy, cognitoSub)

	out := make([]domain.TrackingWithHistory, 0, len(orderIDs))
	for _, id := range orderIDs {
		if owner, exists := r.owned[id]; exists && owner == cognitoSub {
			out = append(out, r.row(id, owner))
		}
	}
	return out, nil
}

func (r *fakeReadsRepo) ListCalls() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.listCalls
}

func (r *fakeReadsRepo) GetCalls() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.getCalls
}

func (r *fakeReadsRepo) ScopedBy() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.scopedBy...)
}

// fakeReadsCache is an in-memory Gateway. It records writes and the TTL each was
// given, which is how the 60s rule and the "a 404 is never cached" rule are
// asserted.
type fakeReadsCache struct {
	mu      sync.Mutex
	entries map[string][]byte
	writes  int
	lastTTL time.Duration
	// bypass makes every Get answer as an unreachable Redis.
	bypass bool
}

func newFakeReadsCache() *fakeReadsCache {
	return &fakeReadsCache{entries: map[string][]byte{}}
}

func (c *fakeReadsCache) Get(_ context.Context, key string) cache.Entry {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.bypass {
		return cache.Entry{Bypassed: true}
	}
	raw, ok := c.entries[key]
	if !ok {
		return cache.Entry{}
	}
	return cache.Entry{Hit: true, Value: raw, TTLRemaining: int(c.lastTTL.Seconds())}
}

func (c *fakeReadsCache) Set(_ context.Context, key string, value any, ttl time.Duration, _ string) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = encoded
	c.writes++
	c.lastTTL = ttl
}

func (c *fakeReadsCache) Invalidate(context.Context, ...string)   {}
func (c *fakeReadsCache) InvalidateIndex(context.Context, string) {}

func (c *fakeReadsCache) Writes() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.writes
}

func (c *fakeReadsCache) LastTTL() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastTTL
}

func (c *fakeReadsCache) Keys() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.entries))
	for k := range c.entries {
		out = append(out, k)
	}
	return out
}

// ─── harness ────────────────────────────────────────────────────────────────

type readsDeps struct {
	owned        map[string]string
	cacheEnabled bool
	cacheBypass  bool
	// noUserID suppresses the resolved usr_ id, which makes every request
	// unkeyable — the cache must then be skipped entirely.
	noUserID bool

	repo  *fakeReadsRepo
	cache *fakeReadsCache
}

func newReadsRouter(t *testing.T, deps *readsDeps) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	if deps.owned == nil {
		deps.owned = map[string]string{}
	}
	deps.repo = &fakeReadsRepo{owned: deps.owned}
	deps.cache = newFakeReadsCache()
	deps.cache.bypass = deps.cacheBypass

	gateway := cache.Gateway(deps.cache)
	if !deps.cacheEnabled {
		gateway = cache.NewNullGateway()
	}

	handler := adapterhttp.NewReadsHandler(
		app.NewGetMyTracking(deps.repo),
		app.NewListMyTrackings(deps.repo),
		gateway,
		deps.cacheEnabled,
		slog.New(slog.NewJSONHandler(io.Discard, nil)),
	)

	router := gin.New()
	// Stands in for whatever middleware resolves the internal usr_ id. The
	// handler must never invent one from the header.
	router.Use(func(c *gin.Context) {
		if !deps.noUserID {
			adapterhttp.SetResolvedUserID(c, readsRowUserID)
		}
		c.Next()
	})
	adapterhttp.RegisterReads(router, handler)
	return router
}

func doRead(t *testing.T, deps *readsDeps, target, callerSub string) *httptest.ResponseRecorder {
	t.Helper()
	return doReadOn(t, newReadsRouter(t, deps), target, callerSub)
}

func doReadOn(t *testing.T, router *gin.Engine, target, callerSub string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	// NewRequestWithContext, not NewRequest: noctx rejects the latter.
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, target, nil)
	if callerSub != "" {
		req.Header.Set("x-user-id", callerSub)
	}
	router.ServeHTTP(rec, req)
	return rec
}

// ─── GET /v1/trackings/{order_id} ───────────────────────────────────────────

func TestSingleRead(t *testing.T) {
	t.Run("200 is a FLAT TrackingResponse, not wrapped", func(t *testing.T) {
		rec := doRead(t, &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}},
			"/v1/trackings/ord_1", readsOwnerSub)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body)
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if _, wrapped := body["tracking"]; wrapped {
			t.Fatal("the single read must NOT be wrapped under \"tracking\"")
		}
		for _, key := range []string{"id", "user_id", "order_id", "status", "datetime", "history"} {
			if _, ok := body[key]; !ok {
				t.Errorf("missing %q in %s", key, rec.Body)
			}
		}
		for _, forbidden := range []string{"shipping_address", "cognito_sub", "tracking_number"} {
			if _, present := body[forbidden]; present {
				t.Errorf("%q must never appear on a response", forbidden)
			}
		}
	})

	t.Run("the response carries the tracking together with its history", func(t *testing.T) {
		rec := doRead(t, &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}},
			"/v1/trackings/ord_1", readsOwnerSub)

		var body struct {
			History []map[string]any `json:"history"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if len(body.History) == 0 {
			t.Fatalf("history is empty in %s", rec.Body)
		}
		for _, forbidden := range []string{"shipping_address", "cognito_sub"} {
			if _, present := body.History[0][forbidden]; present {
				t.Errorf("%q must never appear on a history entry", forbidden)
			}
		}
	})

	t.Run("datetime is an ISO STRING with a Z, never RFC3339 and never null", func(t *testing.T) {
		rec := doRead(t, &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}},
			"/v1/trackings/ord_1", readsOwnerSub)

		var body struct {
			Datetime any `json:"datetime"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		got, isString := body.Datetime.(string)
		if !isString {
			t.Fatalf("datetime is %T (%v), want a string", body.Datetime, body.Datetime)
		}
		if !strings.HasSuffix(got, "Z") || strings.Contains(got, "+00:00") {
			t.Errorf("datetime = %q, want Python's isoformat()+\"Z\"", got)
		}
	})

	t.Run("someone else's tracking is 404, never 403", func(t *testing.T) {
		// The tracking EXISTS and is owned by a different sub. Two different
		// identity values, so this test can actually fail on the ownership bug.
		rec := doRead(t, &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}},
			"/v1/trackings/ord_1", "sub-intruder")

		if rec.Code == http.StatusForbidden {
			t.Fatal("403 confirms the tracking exists — this endpoint must not be " +
				"an oracle for other people's order ids")
		}
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body["detail"] != "tracking not found" {
			t.Errorf("body = %s, want flat {\"detail\":\"tracking not found\"}", rec.Body)
		}
		if _, nested := body["detail"].(map[string]any); nested {
			t.Error("the single read's 404 is Shape A (flat), never the nested Shape B")
		}
		if _, present := body["reason"]; present {
			t.Error("the single read's 404 carries no reason field")
		}
	})

	t.Run("a missing tracking is byte-identical to a non-owned one", func(t *testing.T) {
		deps := &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}}
		nonOwned := doRead(t, deps, "/v1/trackings/ord_1", "sub-intruder")
		missing := doRead(t, deps, "/v1/trackings/ord_nonexistent", "sub-intruder")

		if nonOwned.Code != missing.Code || nonOwned.Body.String() != missing.Body.String() {
			t.Fatalf("responses differ: non-owned %d %s vs missing %d %s",
				nonOwned.Code, nonOwned.Body, missing.Code, missing.Body)
		}
	})

	t.Run("ownership is scoped by cognito_sub, not user_id", func(t *testing.T) {
		// The row's user_id and cognito_sub are DIFFERENT strings. A handler
		// filtering by user_id would 404 the rightful owner here.
		deps := &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}}

		rec := doRead(t, deps, "/v1/trackings/ord_1", readsOwnerSub)
		if rec.Code != http.StatusOK {
			t.Fatalf("the rightful owner got %d — the read is scoped by the wrong "+
				"identity", rec.Code)
		}

		rec = doRead(t, deps, "/v1/trackings/ord_1", readsRowUserID)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("the internal usr_ id resolved a tracking (%d) — the read must "+
				"scope by cognito_sub only", rec.Code)
		}
	})

	t.Run("the identity handed to the port is the header sub, not the resolved usr_ id", func(t *testing.T) {
		deps := &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}}
		doRead(t, deps, "/v1/trackings/ord_1", readsOwnerSub)

		scoped := deps.repo.ScopedBy()
		if len(scoped) != 1 {
			t.Fatalf("the port was called %d times, want 1", len(scoped))
		}
		if scoped[0] != readsOwnerSub {
			t.Fatalf("the port was scoped by %q, want the caller's sub %q", scoped[0], readsOwnerSub)
		}
		if scoped[0] == readsRowUserID {
			t.Fatal("the port was scoped by the internal usr_ id")
		}
	})

	t.Run("missing x-user-id is 401 shape A", func(t *testing.T) {
		rec := doRead(t, &readsDeps{}, "/v1/trackings/ord_1", "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body["detail"] != "missing x-user-id" {
			t.Errorf("body = %s, want flat {\"detail\":\"missing x-user-id\"}", rec.Body)
		}
	})

	// nginx sets x-user-id to the EMPTY STRING rather than omitting it when the
	// token is missing. Accepting "" would scope the read to cognito_sub = "".
	t.Run("a blank x-user-id is 401, never a read scoped to the empty string", func(t *testing.T) {
		deps := &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}}
		router := newReadsRouter(t, deps)

		rec := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/v1/trackings/ord_1", nil)
		req.Header.Set("x-user-id", "   ")
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
		if deps.repo.GetCalls() != 0 {
			t.Fatal("a blank sub reached the database")
		}
	})

	t.Run("cache: miss then hit, X-Cache stamped, TTL 60", func(t *testing.T) {
		deps := &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}, cacheEnabled: true}
		router := newReadsRouter(t, deps)

		first := doReadOn(t, router, "/v1/trackings/ord_1", readsOwnerSub)
		if got := first.Header().Get("X-Cache"); got != "MISS" {
			t.Fatalf("first X-Cache = %q, want MISS", got)
		}

		second := doReadOn(t, router, "/v1/trackings/ord_1", readsOwnerSub)
		if got := second.Header().Get("X-Cache"); got != "HIT" {
			t.Fatalf("second X-Cache = %q, want HIT", got)
		}
		if ttl := deps.cache.LastTTL(); ttl != 60*time.Second {
			t.Errorf("cache TTL = %v, want 60s", ttl)
		}
		if first.Body.String() != second.Body.String() {
			t.Errorf("the cached body differs from the fresh one:\n%s\n%s", first.Body, second.Body)
		}
		if deps.repo.GetCalls() != 1 {
			t.Errorf("the database was hit %d times, want 1 — the second read must "+
				"be served from the cache", deps.repo.GetCalls())
		}
	})

	// A HIT carries the seconds remaining; a MISS has nothing to report.
	t.Run("X-Cache-TTL appears on a hit and never on a miss", func(t *testing.T) {
		deps := &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}, cacheEnabled: true}
		router := newReadsRouter(t, deps)

		first := doReadOn(t, router, "/v1/trackings/ord_1", readsOwnerSub)
		if got := first.Header().Get("X-Cache-TTL"); got != "" {
			t.Errorf("X-Cache-TTL = %q on a MISS, want no header", got)
		}
		second := doReadOn(t, router, "/v1/trackings/ord_1", readsOwnerSub)
		if got := second.Header().Get("X-Cache-TTL"); got != "60" {
			t.Errorf("X-Cache-TTL = %q on a HIT, want 60", got)
		}
	})

	// A MISS means "Redis answered and had nothing"; a BYPASS means "Redis did
	// not answer". Collapsing them makes an outage read as a poor hit rate.
	t.Run("an unreachable cache is BYPASS, not MISS", func(t *testing.T) {
		deps := &readsDeps{
			owned: map[string]string{"ord_1": readsOwnerSub}, cacheEnabled: true, cacheBypass: true,
		}
		rec := doRead(t, deps, "/v1/trackings/ord_1", readsOwnerSub)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 — a cache outage must not fail the read", rec.Code)
		}
		if got := rec.Header().Get("X-Cache"); got != "BYPASS" {
			t.Fatalf("X-Cache = %q, want BYPASS", got)
		}
	})

	// The two identities key every entry. Without a resolved usr_ id the key
	// would lie about what it is scoped by, so the request is not cached at all.
	t.Run("an unresolvable user_id skips the cache entirely", func(t *testing.T) {
		deps := &readsDeps{
			owned: map[string]string{"ord_1": readsOwnerSub}, cacheEnabled: true, noUserID: true,
		}
		rec := doRead(t, deps, "/v1/trackings/ord_1", readsOwnerSub)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Header().Get("X-Cache"); got != "MISS" {
			t.Errorf("X-Cache = %q, want MISS for an unkeyable request", got)
		}
		if deps.cache.Writes() != 0 {
			t.Fatal("an unkeyable request was written to the cache")
		}
	})

	t.Run("a 404 is never cached", func(t *testing.T) {
		deps := &readsDeps{cacheEnabled: true}
		doRead(t, deps, "/v1/trackings/ord_missing", readsOwnerSub)
		if deps.cache.Writes() != 0 {
			t.Fatal("a 404 was written to the cache")
		}
	})

	t.Run("a 401 is never cached", func(t *testing.T) {
		deps := &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}, cacheEnabled: true}
		doRead(t, deps, "/v1/trackings/ord_1", "")
		if deps.cache.Writes() != 0 {
			t.Fatal("a 401 was written to the cache")
		}
	})

	// Two callers must never share an entry, whatever the order id.
	t.Run("the cache key is per-caller", func(t *testing.T) {
		deps := &readsDeps{
			owned:        map[string]string{"ord_1": readsOwnerSub, "ord_2": "sub-other"},
			cacheEnabled: true,
		}
		router := newReadsRouter(t, deps)

		doReadOn(t, router, "/v1/trackings/ord_1", readsOwnerSub)
		intruder := doReadOn(t, router, "/v1/trackings/ord_1", "sub-intruder")

		if intruder.Code != http.StatusNotFound {
			t.Fatalf("a second caller read %d from the first caller's cached entry", intruder.Code)
		}
	})

	t.Run("with the cache disabled no header is stamped at all", func(t *testing.T) {
		deps := &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}, cacheEnabled: false}
		rec := doRead(t, deps, "/v1/trackings/ord_1", readsOwnerSub)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Header().Get("X-Cache"); got != "" {
			t.Fatalf("X-Cache = %q with the cache off, want no header — the load "+
				"test's control arm must look like a service with no cache", got)
		}
		if got := rec.Header().Get("X-Cache-TTL"); got != "" {
			t.Fatalf("X-Cache-TTL = %q with the cache off, want no header", got)
		}
	})
}

// ─── GET /v1/trackings?order_ids= ───────────────────────────────────────────

func TestBatchRead(t *testing.T) {
	t.Run("200 is an object with a trackings key, never a bare array", func(t *testing.T) {
		deps := &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub, "ord_2": readsOwnerSub}}
		rec := doRead(t, deps, "/v1/trackings?order_ids=ord_1,ord_2", readsOwnerSub)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body)
		}
		if strings.HasPrefix(strings.TrimSpace(rec.Body.String()), "[") {
			t.Fatal("the batch read returned a bare array")
		}
		var body struct {
			Trackings []map[string]any `json:"trackings"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if len(body.Trackings) != 2 {
			t.Fatalf("got %d trackings, want 2", len(body.Trackings))
		}
		for _, forbidden := range []string{"shipping_address", "cognito_sub"} {
			if _, present := body.Trackings[0][forbidden]; present {
				t.Errorf("%q must never appear on a response", forbidden)
			}
		}
		if _, hasHistory := body.Trackings[0]["history"]; !hasHistory {
			t.Error("the batch read must return each tracking TOGETHER with its history")
		}
	})

	t.Run("unknown and non-owned ids are silently omitted, still 200", func(t *testing.T) {
		deps := &readsDeps{owned: map[string]string{"ord_mine": readsOwnerSub, "ord_theirs": "sub-other"}}
		rec := doRead(t, deps, "/v1/trackings?order_ids=ord_mine,ord_theirs,ord_nope", readsOwnerSub)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 — the batch read has no 404 by design", rec.Code)
		}
		var body struct {
			Trackings []struct {
				OrderID string `json:"order_id"`
			} `json:"trackings"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if len(body.Trackings) != 1 || body.Trackings[0].OrderID != "ord_mine" {
			t.Fatalf("got %+v, want exactly [ord_mine]", body.Trackings)
		}
	})

	t.Run("no match is 200 with an empty list, not null", func(t *testing.T) {
		rec := doRead(t, &readsDeps{}, "/v1/trackings?order_ids=ord_nope", readsOwnerSub)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), `"trackings":[]`) {
			t.Errorf("body = %s, want an empty ARRAY, not null", rec.Body)
		}
	})

	t.Run("101 distinct ids is 400 shape A without the reason token", func(t *testing.T) {
		ids := make([]string, 101)
		for i := range ids {
			ids[i] = fmt.Sprintf("ord_%d", i)
		}
		deps := &readsDeps{}
		rec := doRead(t, deps, "/v1/trackings?order_ids="+strings.Join(ids, ","), readsOwnerSub)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body["detail"] != "at most 100 order_ids per request" {
			t.Errorf("detail = %v, want the exact message", body["detail"])
		}
		if _, present := body["reason"]; present {
			t.Error("too_many_order_ids belongs on the log and span, never in the body")
		}
		if strings.Contains(rec.Body.String(), "too_many_order_ids") {
			t.Error("the reason token leaked into the body")
		}
		if deps.repo.ListCalls() != 0 {
			t.Error("an over-cap request reached the database")
		}
	})

	t.Run("100 DISTINCT ids is allowed; duplicates do not count toward the cap", func(t *testing.T) {
		ids := make([]string, 100)
		for i := range ids {
			ids[i] = fmt.Sprintf("ord_%d", i)
		}
		rec := doRead(t, &readsDeps{}, "/v1/trackings?order_ids="+strings.Join(ids, ","), readsOwnerSub)
		if rec.Code != http.StatusOK {
			t.Fatalf("100 ids = %d, want 200", rec.Code)
		}
		// 101 raw parts collapsing to 100 distinct must also pass.
		rec = doRead(t, &readsDeps{},
			"/v1/trackings?order_ids="+strings.Join(append(ids, "ord_0"), ","), readsOwnerSub)
		if rec.Code != http.StatusOK {
			t.Fatalf("101 raw / 100 distinct = %d, want 200 — the cap counts DISTINCT "+
				"NON-EMPTY ids", rec.Code)
		}
		// 101 raw parts of which one is blank also collapses to 100.
		rec = doRead(t, &readsDeps{},
			"/v1/trackings?order_ids="+strings.Join(ids, ",")+",", readsOwnerSub)
		if rec.Code != http.StatusOK {
			t.Fatalf("100 ids + a trailing comma = %d, want 200 — blanks are dropped "+
				"before the cap is applied", rec.Code)
		}
	})

	t.Run("the parameter being absent entirely is 422, not 400", func(t *testing.T) {
		rec := doRead(t, &readsDeps{}, "/v1/trackings", readsOwnerSub)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422 — c.Query returns \"\" with no error, so "+
				"presence must be checked explicitly", rec.Code)
		}
		var body struct {
			Detail []struct {
				Loc  []string `json:"loc"`
				Msg  string   `json:"msg"`
				Type string   `json:"type"`
			} `json:"detail"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("the 422 body is not FastAPI's Shape D: %s", rec.Body)
		}
		if len(body.Detail) != 1 || body.Detail[0].Type != "missing" {
			t.Errorf("body = %s, want a single missing-field detail", rec.Body)
		}
		if len(body.Detail[0].Loc) != 2 || body.Detail[0].Loc[0] != "query" {
			t.Errorf("loc = %v, want [query order_ids]", body.Detail[0].Loc)
		}
	})

	// PRESENT-BUT-EMPTY is a different case from ABSENT: it parses to zero ids,
	// which is a well-defined request for nothing.
	t.Run("an empty value short-circuits without touching the database", func(t *testing.T) {
		deps := &readsDeps{}
		rec := doRead(t, deps, "/v1/trackings?order_ids=,,", readsOwnerSub)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), `"trackings":[]`) {
			t.Errorf("body = %s, want an empty array", rec.Body)
		}
		if deps.repo.ListCalls() != 0 {
			t.Fatal("an empty id list reached the database — sqlc's IN (sqlc.slice()) " +
				"generates invalid SQL for an empty slice")
		}
	})

	t.Run("order_ids= with nothing after it is 200, not 422", func(t *testing.T) {
		deps := &readsDeps{}
		rec := doRead(t, deps, "/v1/trackings?order_ids=", readsOwnerSub)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 — the parameter IS present", rec.Code)
		}
		if deps.repo.ListCalls() != 0 {
			t.Fatal("an empty id list reached the database")
		}
	})

	t.Run("ownership is scoped by cognito_sub, not user_id", func(t *testing.T) {
		deps := &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}}

		rec := doRead(t, deps, "/v1/trackings?order_ids=ord_1", readsOwnerSub)
		var body struct {
			Trackings []map[string]any `json:"trackings"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if len(body.Trackings) != 1 {
			t.Fatalf("the rightful owner got %d trackings — the list is scoped by the "+
				"wrong identity", len(body.Trackings))
		}

		// The row's internal usr_ id must resolve NOTHING.
		rec = doRead(t, deps, "/v1/trackings?order_ids=ord_1", readsRowUserID)
		body.Trackings = nil
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if len(body.Trackings) != 0 {
			t.Fatalf("the internal usr_ id resolved %d trackings — the list must scope "+
				"by cognito_sub only", len(body.Trackings))
		}
	})

	t.Run("missing x-user-id is 401", func(t *testing.T) {
		rec := doRead(t, &readsDeps{}, "/v1/trackings?order_ids=ord_1", "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})

	t.Run("cache: miss then hit, X-Cache stamped, TTL 60", func(t *testing.T) {
		deps := &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}, cacheEnabled: true}
		router := newReadsRouter(t, deps)

		first := doReadOn(t, router, "/v1/trackings?order_ids=ord_1", readsOwnerSub)
		if got := first.Header().Get("X-Cache"); got != "MISS" {
			t.Fatalf("first X-Cache = %q, want MISS", got)
		}
		second := doReadOn(t, router, "/v1/trackings?order_ids=ord_1", readsOwnerSub)
		if got := second.Header().Get("X-Cache"); got != "HIT" {
			t.Fatalf("second X-Cache = %q, want HIT", got)
		}
		if ttl := deps.cache.LastTTL(); ttl != 60*time.Second {
			t.Errorf("cache TTL = %v, want 60s", ttl)
		}
		if first.Body.String() != second.Body.String() {
			t.Errorf("the cached body differs from the fresh one:\n%s\n%s", first.Body, second.Body)
		}
	})

	// The key hashes a SORTED, deduplicated id set, so two orderings of one set
	// share an entry. Asserted here because it is the property that makes the
	// list cache worth having at all.
	t.Run("the list key is order-insensitive", func(t *testing.T) {
		deps := &readsDeps{
			owned:        map[string]string{"ord_1": readsOwnerSub, "ord_2": readsOwnerSub},
			cacheEnabled: true,
		}
		router := newReadsRouter(t, deps)

		doReadOn(t, router, "/v1/trackings?order_ids=ord_1,ord_2", readsOwnerSub)
		reversed := doReadOn(t, router, "/v1/trackings?order_ids=ord_2,ord_1", readsOwnerSub)

		if got := reversed.Header().Get("X-Cache"); got != "HIT" {
			t.Errorf("the reversed id list gave X-Cache=%q, want HIT", got)
		}
	})

	t.Run("a 400 is never cached", func(t *testing.T) {
		ids := make([]string, 101)
		for i := range ids {
			ids[i] = fmt.Sprintf("ord_%d", i)
		}
		deps := &readsDeps{cacheEnabled: true}
		doRead(t, deps, "/v1/trackings?order_ids="+strings.Join(ids, ","), readsOwnerSub)
		if deps.cache.Writes() != 0 {
			t.Fatal("a 400 was written to the cache")
		}
	})

	t.Run("a 422 is never cached", func(t *testing.T) {
		deps := &readsDeps{cacheEnabled: true}
		doRead(t, deps, "/v1/trackings", readsOwnerSub)
		if deps.cache.Writes() != 0 {
			t.Fatal("a 422 was written to the cache")
		}
	})

	t.Run("with the cache disabled no header is stamped at all", func(t *testing.T) {
		deps := &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}, cacheEnabled: false}
		rec := doRead(t, deps, "/v1/trackings?order_ids=ord_1", readsOwnerSub)
		if got := rec.Header().Get("X-Cache"); got != "" {
			t.Fatalf("X-Cache = %q with the cache off, want no header", got)
		}
	})

	// Gin builds one radix tree per method. The batch literal and the wildcard
	// live in the same GET tree, so a bad registration order would either panic
	// at startup or route /v1/trackings into the single read.
	t.Run("the batch route and the single read do not shadow each other", func(t *testing.T) {
		deps := &readsDeps{owned: map[string]string{"ord_1": readsOwnerSub}}
		router := newReadsRouter(t, deps)

		batch := doReadOn(t, router, "/v1/trackings?order_ids=ord_1", readsOwnerSub)
		if batch.Code != http.StatusOK || !strings.Contains(batch.Body.String(), `"trackings"`) {
			t.Fatalf("/v1/trackings answered %d %s, want the batch shape", batch.Code, batch.Body)
		}
		single := doReadOn(t, router, "/v1/trackings/ord_1", readsOwnerSub)
		if single.Code != http.StatusOK || strings.Contains(single.Body.String(), `"trackings"`) {
			t.Fatalf("/v1/trackings/ord_1 answered %d %s, want the flat shape", single.Code, single.Body)
		}
	})
}
