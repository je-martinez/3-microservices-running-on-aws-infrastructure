package http_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	nethttp "net/http"
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
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// The identity-stamping middleware's tests.
//
// The two constants below are DIFFERENT strings, deliberately. The whole point
// of this middleware is that it turns a Cognito sub into an internal usr_ id;
// a fixture using one value for both could not tell a working resolution from
// one that echoed the header back.
//
// Helpers carry the `stamp` prefix — this package is shared by every handler
// suite and generic names have collided across them before.
const (
	stampSub    = "sub-owner-9f2c"
	stampUserID = "usr_internal_abc"
)

// ─── doubles ────────────────────────────────────────────────────────────────

// stampResolver counts how many times the gRPC-backed resolution actually ran.
// That count is the assertion behind "the identity cache is consulted BEFORE
// gRPC": two requests with one call means the cache absorbed the second.
type stampResolver struct {
	mu    sync.Mutex
	calls int
	// asked records the identifier each call was made with.
	asked []string
	// userID is what a successful resolution returns.
	userID string
	// err, when set, is what every call fails with.
	err error
}

func (r *stampResolver) ResolveInternalUserID(_ context.Context, cognitoSub string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	r.asked = append(r.asked, cognitoSub)
	if r.err != nil {
		return "", r.err
	}
	return r.userID, nil
}

func (r *stampResolver) Calls() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

func (r *stampResolver) Asked() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.asked...)
}

// stampGateway is an in-memory cache.Gateway shared across requests, so a value
// written by one request is visible to the next — which is what makes the
// "cache before gRPC" assertion meaningful.
type stampGateway struct {
	mu      sync.Mutex
	entries map[string][]byte
	// down makes every Get answer as an unreachable Redis and every Set a no-op.
	down bool
}

func newStampGateway() *stampGateway {
	return &stampGateway{entries: map[string][]byte{}}
}

func (g *stampGateway) Get(_ context.Context, key string) cache.Entry {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.down {
		return cache.Entry{Bypassed: true}
	}
	raw, ok := g.entries[key]
	if !ok {
		return cache.Entry{}
	}
	return cache.Entry{Hit: true, Value: raw, TTLRemaining: 42}
}

func (g *stampGateway) Set(_ context.Context, key string, value any, _ time.Duration, _ string) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.down {
		return
	}
	g.entries[key] = encoded
}

func (g *stampGateway) Invalidate(context.Context, ...string)   {}
func (g *stampGateway) InvalidateIndex(context.Context, string) {}

func (g *stampGateway) Has(key string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	_, ok := g.entries[key]
	return ok
}

// stampRepo answers the single scoped read. Ownership is compared against the
// COGNITO SUB, exactly as the SQL does — never against the usr_ id.
type stampRepo struct {
	mu    sync.Mutex
	owner string
	calls int
}

func (r *stampRepo) GetByOrderIDScoped(_ context.Context, orderID, cognitoSub string) (domain.TrackingWithHistory, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	if cognitoSub != r.owner {
		return domain.TrackingWithHistory{}, domain.ErrTrackingNotFound
	}
	moment := time.Date(2026, 8, 27, 14, 53, 1, 0, time.UTC)
	return domain.TrackingWithHistory{
		Tracking: domain.Tracking{
			ID:             "trk_" + orderID,
			UserID:         stampUserID,
			CognitoSub:     cognitoSub,
			OrderID:        orderID,
			TrackingNumber: "3MRAI-0000-0000-0001",
			Status:         domain.StatusPlaced,
			Datetime:       moment,
		},
	}, nil
}

// ListByOrderIDsScoped exists so stampRepo satisfies the batch read's port too.
// Unused by these tests: the middleware's behaviour is identical on both reads,
// and one route is enough to observe it.
func (r *stampRepo) ListByOrderIDsScoped(context.Context, []string, string) ([]domain.TrackingWithHistory, error) {
	return nil, nil
}

func (r *stampRepo) Calls() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

// ─── harness ────────────────────────────────────────────────────────────────

type stampDeps struct {
	resolver *stampResolver
	gateway  *stampGateway
	repo     *stampRepo
	logs     *bytes.Buffer
}

// stampReadsHandler builds the real reads handler over the doubles, with the
// response cache ENABLED — the cache is what these tests observe.
func stampReadsHandler(repo *stampRepo, gateway cache.Gateway, log *slog.Logger) *adapterhttp.ReadsHandler {
	return adapterhttp.NewReadsHandler(
		app.NewGetMyTracking(repo),
		app.NewListMyTrackings(repo),
		gateway,
		true,
		log,
	)
}

// stampRouter builds a router carrying the middleware exactly as the composition
// root applies it: the reads and creation get it, the carrier PUT and the two
// deletes do not.
func stampRouter(t *testing.T, deps *stampDeps) *gin.Engine {
	return stampRouterWith(t, deps, nil)
}

// stampRouterWith is stampRouter plus a probe registered AFTER the stamp inside
// the reads group, so a test can observe what the middleware left on the
// gin.Context without reaching into the handler.
func stampRouterWith(t *testing.T, deps *stampDeps, probe gin.HandlerFunc) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	if deps.resolver == nil {
		deps.resolver = &stampResolver{userID: stampUserID}
	}
	if deps.gateway == nil {
		deps.gateway = newStampGateway()
	}
	if deps.repo == nil {
		deps.repo = &stampRepo{owner: stampSub}
	}
	if deps.logs == nil {
		deps.logs = &bytes.Buffer{}
	}
	// WRAPPED IN NewContextHandler, which is what merges the ambient log
	// context into every record. Without it a merge is invisible: the field
	// lands on the context and no handler ever reads it back. This is also the
	// shape logcontext_middleware_test.go uses.
	log := slog.New(logging.NewContextHandler(
		logging.NewHandler(deps.logs, "tracking", "local", slog.LevelDebug)))

	router := gin.New()
	router.Use(adapterhttp.LogContextMiddleware(log, nil))

	stamp := adapterhttp.StampResolvedUserID(deps.resolver, cache.NewIdentityCache(deps.gateway), log)

	reads := router.Group("", stamp)
	if probe != nil {
		reads.Use(probe)
	}
	adapterhttp.RegisterReads(reads, stampReadsHandler(deps.repo, deps.gateway, log))

	// A stand-in for a route the middleware must NOT touch. It reports what the
	// middleware left behind so a test can assert the absence directly.
	router.PUT("/v1/trackings/:order_id/status", func(c *gin.Context) {
		c.JSON(nethttp.StatusOK, gin.H{"resolved": adapterhttp.ResolvedUserID(c)})
	})
	router.DELETE("/v1/trackings/by-user", func(c *gin.Context) {
		c.JSON(nethttp.StatusOK, gin.H{"resolved": adapterhttp.ResolvedUserID(c)})
	})
	router.DELETE("/v1/trackings/e2e-cleanup", func(c *gin.Context) {
		c.JSON(nethttp.StatusOK, gin.H{"resolved": adapterhttp.ResolvedUserID(c)})
	})

	return router
}

func stampGet(t *testing.T, router *gin.Engine, target, sub string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	// NewRequestWithContext, not NewRequest: noctx rejects the latter.
	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, target, nil)
	if sub != "" {
		req.Header.Set("x-user-id", sub)
	}
	router.ServeHTTP(rec, req)
	return rec
}

func stampDo(t *testing.T, router *gin.Engine, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(t.Context(), method, target, nil)
	router.ServeHTTP(rec, req)
	return rec
}

// stampLines decodes every JSON log line the buffer holds.
func stampLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, raw := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if raw == "" {
			continue
		}
		var line map[string]any
		if err := json.Unmarshal([]byte(raw), &line); err != nil {
			t.Fatalf("log line is not JSON: %q (%v)", raw, err)
		}
		out = append(out, line)
	}
	return out
}

// ─── THE GAP THIS TASK CLOSES ───────────────────────────────────────────────

// TestTheResponseCacheActuallyEngages is the assertion whose absence let the
// whole response cache ship inert.
//
// Nothing in production called SetResolvedUserID, so ResolvedUserID answered ""
// for every request, every key builder declined to build a key, and every read
// was a MISS forever — while every unit test passed, because each one stamped
// the id itself in its own fixture middleware. The only test that can catch
// that is one that goes through the REAL wiring and asserts a second identical
// read is a HIT.
func TestTheResponseCacheActuallyEngages(t *testing.T) {
	deps := &stampDeps{}
	router := stampRouter(t, deps)

	first := stampGet(t, router, "/v1/trackings/ord_1", stampSub)
	if first.Code != nethttp.StatusOK {
		t.Fatalf("first read status = %d, want 200: %s", first.Code, first.Body)
	}
	if got := first.Header().Get(adapterhttp.CacheHeader); got != cache.HeaderMiss {
		t.Fatalf("first read X-Cache = %q, want MISS.\n"+
			"An empty header means the read never even tried; a MISS on a request "+
			"that could not be keyed means the usr_ id was never stamped.", got)
	}

	second := stampGet(t, router, "/v1/trackings/ord_1", stampSub)
	if second.Code != nethttp.StatusOK {
		t.Fatalf("second read status = %d, want 200: %s", second.Code, second.Body)
	}
	if got := second.Header().Get(adapterhttp.CacheHeader); got != cache.HeaderHit {
		t.Fatalf("second read X-Cache = %q, want HIT.\n"+
			"A MISS here is THE bug this task exists to close: with no middleware "+
			"stamping the resolved usr_ id, TrackingOrderKey answers \"not keyable\" "+
			"and the response cache never stores or serves anything.", got)
	}
	if second.Body.String() != first.Body.String() {
		t.Errorf("the cached body differs from the computed one:\n first: %s\nsecond: %s",
			first.Body, second.Body)
	}
	if calls := deps.repo.Calls(); calls != 1 {
		t.Errorf("the repository ran %d times across two identical reads, want 1", calls)
	}
}

// TestTheStampedValueIsTheUSRIDAndNeverTheSub is the two-identities rule, at the
// one place in this service where the translation actually happens.
//
// x-user-id carries the JWT SUB, not the internal usr_ id, and the whole purpose
// of this middleware is to turn one into the other. Stamping the sub instead
// would look implemented, keep every cache assertion green (a key built from the
// sub is still a key, and it still hits on a second identical request) and put a
// sub into the user_id segment of every response key and onto every log line —
// where a dashboard joining Tracking to Orders and Users on user_id would then
// match nothing at all. That mutant survives every other test in this file.
func TestTheStampedValueIsTheUSRIDAndNeverTheSub(t *testing.T) {
	deps := &stampDeps{}

	var stamped string
	var seen bool
	router := stampRouterWith(t, deps, func(c *gin.Context) {
		c.Next()
		stamped, seen = adapterhttp.ResolvedUserID(c), true
	})

	stampGet(t, router, "/v1/trackings/ord_1", stampSub)

	if !seen {
		t.Fatal("the probe never ran")
	}
	if stamped == stampSub {
		t.Fatalf("ResolvedUserID = %q, which is the COGNITO SUB. The stamped value "+
			"must be the resolved usr_ id: a sub in the user_id segment of a cache "+
			"key, and on the user_id log field, matches nothing in any cross-service "+
			"join and silently mis-describes every read.", stamped)
	}
	if stamped != stampUserID {
		t.Fatalf("ResolvedUserID = %q, want the resolved %q", stamped, stampUserID)
	}
}

// The same rule on the LOG side: the request line's user_id and cognito_sub must
// be the two DIFFERENT values, never one value under both names.
func TestTheRequestLineCarriesBothIdentitiesDistinctly(t *testing.T) {
	deps := &stampDeps{}
	router := stampRouter(t, deps)

	stampGet(t, router, "/v1/trackings/ord_1", stampSub)

	for _, line := range stampLines(t, deps.logs) {
		if line["message"] != "request completed" {
			continue
		}
		userID, _ := line["user_id"].(string)
		sub, _ := line["cognito_sub"].(string)
		if userID == sub {
			t.Fatalf("user_id and cognito_sub are both %q — the two identities are "+
				"different strings for the same person and must never be conflated", userID)
		}
		if userID != stampUserID || sub != stampSub {
			t.Errorf("user_id = %q (want %q), cognito_sub = %q (want %q)",
				userID, stampUserID, sub, stampSub)
		}
	}
}

// ─── The identity cache sits in front of gRPC ───────────────────────────────

// TestIdentityIsResolvedThroughTheCacheNotStraightToGRPC pins the reason the
// identity cache exists at all: a response-cache HIT that still paid a gRPC
// round trip would have given back most of the latency the cache was added to
// remove.
func TestIdentityIsResolvedThroughTheCacheNotStraightToGRPC(t *testing.T) {
	deps := &stampDeps{}
	router := stampRouter(t, deps)

	// Two DIFFERENT order ids, so the response cache cannot absorb the second
	// request and the middleware genuinely runs twice.
	stampGet(t, router, "/v1/trackings/ord_1", stampSub)
	stampGet(t, router, "/v1/trackings/ord_2", stampSub)

	if calls := deps.resolver.Calls(); calls != 1 {
		t.Fatalf("the Users gRPC client was called %d times across two requests, want 1.\n"+
			"Two calls means the middleware bypassed the identity cache and asked "+
			"Users on every request — the round trip the cache exists to remove.", calls)
	}
	if !deps.gateway.Has(cache.IdentityKey(stampSub)) {
		t.Error("no identity entry was written; the resolution never went through the cache")
	}
}

// The cache is keyed on the RAW header value, whatever identifier the client
// sent, and that is the identifier handed to Users — GetUserById accepts both.
func TestTheResolverIsAskedWithTheRawHeaderValue(t *testing.T) {
	deps := &stampDeps{}
	router := stampRouter(t, deps)

	stampGet(t, router, "/v1/trackings/ord_1", stampSub)

	asked := deps.resolver.Asked()
	if len(asked) != 1 || asked[0] != stampSub {
		t.Fatalf("the resolver was asked %v, want exactly [%q]", asked, stampSub)
	}
}

// ─── Failure is never fatal ─────────────────────────────────────────────────

// TestAFailedResolutionStillServesTheRead is the READ path's contract: the usr_
// id is log enrichment plus a cache key, and neither is worth failing a request
// over. Users being down, slow, or holding no record for the sub all end the
// same way — a 200 that is simply not cached.
func TestAFailedResolutionStillServesTheRead(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"users has no record for this sub", domain.ErrUserNotFound},
		{"users is unreachable", errors.New("rpc error: code = Unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deps := &stampDeps{resolver: &stampResolver{err: tc.err}}
			router := stampRouter(t, deps)

			first := stampGet(t, router, "/v1/trackings/ord_1", stampSub)
			if first.Code != nethttp.StatusOK {
				t.Fatalf("status = %d, want 200: a failed enrichment must NEVER fail the read: %s",
					first.Code, first.Body)
			}

			second := stampGet(t, router, "/v1/trackings/ord_1", stampSub)
			if second.Code != nethttp.StatusOK {
				t.Fatalf("second status = %d, want 200", second.Code)
			}
			if got := second.Header().Get(adapterhttp.CacheHeader); got == cache.HeaderHit {
				t.Fatalf("X-Cache = HIT on a request with no resolved usr_ id.\n" +
					"An unkeyable request must never claim a hit — the key would be " +
					"scoped by an empty user_id and collapse several callers onto one entry.")
			}
			if calls := deps.repo.Calls(); calls != 2 {
				t.Errorf("the repository ran %d times, want 2 — an unkeyable read is "+
					"served from the database every time", calls)
			}
		})
	}
}

// A negative is never cached, so the next request re-asks. Asserted here (not
// only in the identity cache's own suite) because the middleware is what wires
// the two together, and a middleware that cached its own failure would keep a
// recovered user's id out of their keys for the whole hour.
func TestAFailedResolutionIsReAskedOnTheNextRequest(t *testing.T) {
	deps := &stampDeps{resolver: &stampResolver{err: domain.ErrUserNotFound}}
	router := stampRouter(t, deps)

	stampGet(t, router, "/v1/trackings/ord_1", stampSub)
	stampGet(t, router, "/v1/trackings/ord_1", stampSub)

	if calls := deps.resolver.Calls(); calls != 2 {
		t.Fatalf("the resolver ran %d times, want 2 — a negative must never be cached", calls)
	}
	if deps.gateway.Has(cache.IdentityKey(stampSub)) {
		t.Error("a negative answer was written to the identity cache")
	}
}

// A Redis outage degrades to a direct gRPC resolution rather than to no
// resolution: the read is still enriched and still keyed, it simply pays the
// round trip the cache would have saved.
func TestResolutionSurvivesARedisOutage(t *testing.T) {
	gateway := newStampGateway()
	gateway.down = true
	deps := &stampDeps{gateway: gateway}
	router := stampRouter(t, deps)

	rec := stampGet(t, router, "/v1/trackings/ord_1", stampSub)
	if rec.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if calls := deps.resolver.Calls(); calls != 1 {
		t.Errorf("the resolver ran %d times, want 1 — a Redis outage must fall through to gRPC", calls)
	}
}

// ─── Logging ────────────────────────────────────────────────────────────────

// On success the id must reach the LOG CONTEXT, not merely the gin.Context: the
// point of paying for the resolution on a read is that the request line carries
// user_id, so a dashboard can join Tracking to Orders and Users.
func TestASuccessfulResolutionReachesTheRequestLine(t *testing.T) {
	deps := &stampDeps{}
	router := stampRouter(t, deps)

	stampGet(t, router, "/v1/trackings/ord_1", stampSub)

	var found bool
	for _, line := range stampLines(t, deps.logs) {
		if line["message"] != "request completed" {
			continue
		}
		found = true
		if got, _ := line["user_id"].(string); got != stampUserID {
			t.Errorf("request line user_id = %q, want %q — the resolved id must be "+
				"MERGED INTO THE LOG CONTEXT, not only stashed on the gin.Context",
				got, stampUserID)
		}
		if got, _ := line["cognito_sub"].(string); got != stampSub {
			t.Errorf("request line cognito_sub = %q, want %q", got, stampSub)
		}
	}
	if !found {
		t.Fatalf("no `request completed` line was emitted: %s", deps.logs)
	}
}

// A failure is DEBUG with a machine-readable reason — never WARN. For a caller
// Users has never seen this is an expected outcome, and one WARN per request
// during a Users blip would bury every real signal in the stream.
func TestAFailedResolutionLogsDebugWithAReason(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want string
	}{
		{"an unknown user", domain.ErrUserNotFound, "unknown_user"},
		{"an outage", errors.New("rpc error: code = Unavailable"), "users_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deps := &stampDeps{resolver: &stampResolver{err: tc.err}}
			router := stampRouter(t, deps)

			stampGet(t, router, "/v1/trackings/ord_1", stampSub)

			var found bool
			for _, line := range stampLines(t, deps.logs) {
				if line["app_event"] != "log_identity_unresolved" {
					continue
				}
				found = true
				if severity, _ := line["severity_text"].(string); severity != "DEBUG" {
					t.Errorf("severity = %q, want DEBUG: an unresolvable caller is an "+
						"EXPECTED outcome on a read, and a WARN per request during a "+
						"Users blip buries the real signal", severity)
				}
				if got, _ := line["reason"].(string); got != tc.want {
					t.Errorf("reason = %q, want %q", got, tc.want)
				}
			}
			if !found {
				t.Fatalf("no log_identity_unresolved line: %s", deps.logs)
			}
		})
	}
}

// The request line must never carry an EMPTY user_id: an emitted "" reads as a
// resolved identity that happened to be blank, rather than "not known here".
func TestAFailedResolutionOmitsUserIDRatherThanEmittingItEmpty(t *testing.T) {
	deps := &stampDeps{resolver: &stampResolver{err: domain.ErrUserNotFound}}
	router := stampRouter(t, deps)

	stampGet(t, router, "/v1/trackings/ord_1", stampSub)

	for _, line := range stampLines(t, deps.logs) {
		if _, present := line["user_id"]; present {
			t.Errorf("user_id is present on %v; an unresolved identity is OMITTED, never null or empty", line)
		}
	}
}

// PII rule: nothing this middleware logs may carry an email, a token or an
// address. It only ever holds two opaque identifiers, and this pins that.
func TestTheMiddlewareLogsNoPII(t *testing.T) {
	deps := &stampDeps{resolver: &stampResolver{err: errors.New("dial tcp: connection refused to user@example.com")}}
	router := stampRouter(t, deps)

	stampGet(t, router, "/v1/trackings/ord_1", stampSub)

	for _, line := range stampLines(t, deps.logs) {
		if line["app_event"] != "log_identity_unresolved" {
			continue
		}
		encoded, err := json.Marshal(line)
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{"@", "email", "shipping_address", "token", "api_key"} {
			if strings.Contains(string(encoded), forbidden) {
				t.Errorf("the failure line carries %q: %s", forbidden, encoded)
			}
		}
	}
}

// ─── The routes the middleware must never touch ─────────────────────────────

// TestTheMiddlewareNeverRunsOnTheIdentitylessRoutes covers the carrier PUT and
// the two deletes.
//
// None of the three carries an x-user-id at all: the carrier's gateway route
// declares no Cognito authorizer, and both deletes are authenticated by an API
// key with their subject in the body or in a tag. Resolving there would pay a
// gRPC call on a request that has no identity to resolve — and a middleware
// guarding merely on "the header is present" would still fire on a stray one.
func TestTheMiddlewareNeverRunsOnTheIdentitylessRoutes(t *testing.T) {
	for _, tc := range []struct {
		name   string
		method string
		target string
	}{
		{"the carrier PUT", nethttp.MethodPut, "/v1/trackings/ord_1/status"},
		{"the account-deletion cascade", nethttp.MethodDelete, "/v1/trackings/by-user"},
		{"the e2e cleanup", nethttp.MethodDelete, "/v1/trackings/e2e-cleanup"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deps := &stampDeps{}
			router := stampRouter(t, deps)

			rec := stampDo(t, router, tc.method, tc.target)
			if rec.Code != nethttp.StatusOK {
				t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body)
			}
			if calls := deps.resolver.Calls(); calls != 0 {
				t.Errorf("the resolver ran %d times on %s %s, want 0 — this route "+
					"carries no caller identity and must never reach Users",
					calls, tc.method, tc.target)
			}

			var body struct {
				Resolved string `json:"resolved"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Resolved != "" {
				t.Errorf("ResolvedUserID = %q on a route with no caller identity, want \"\"", body.Resolved)
			}
		})
	}
}

// A stray x-user-id on the carrier PUT must change nothing. This is the case a
// header-presence guard inside a GLOBAL middleware would get wrong: it would
// fire on the stray header and pay a gRPC call on a request that has no
// business making one. Applying the middleware PER ROUTE makes it structural.
func TestAStrayHeaderOnTheCarrierPUTResolvesNothing(t *testing.T) {
	deps := &stampDeps{}
	router := stampRouter(t, deps)

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodPut,
		"/v1/trackings/ord_1/status", nil)
	req.Header.Set("x-user-id", stampSub)
	router.ServeHTTP(rec, req)

	if calls := deps.resolver.Calls(); calls != 0 {
		t.Fatalf("the resolver ran %d times on a carrier PUT carrying a stray "+
			"x-user-id, want 0", calls)
	}
}

// ─── Degenerate wirings ─────────────────────────────────────────────────────

// No sub on the request means nothing to resolve: no gRPC call, no cache
// lookup, and the read answers its own 401.
func TestNoSubMeansNoResolution(t *testing.T) {
	deps := &stampDeps{}
	router := stampRouter(t, deps)

	rec := stampGet(t, router, "/v1/trackings/ord_1", "")
	if rec.Code != nethttp.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if calls := deps.resolver.Calls(); calls != 0 {
		t.Errorf("the resolver ran %d times for a request with no sub, want 0", calls)
	}
}

// A process wired with no Users client at all (grpc.Dial failed at startup) must
// keep serving every read. The middleware degrades to a no-op.
func TestANilResolverDegradesToANoOp(t *testing.T) {
	gateway := newStampGateway()
	repo := &stampRepo{owner: stampSub}
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))

	router := gin.New()
	reads := router.Group("", adapterhttp.StampResolvedUserID(nil, cache.NewIdentityCache(gateway), log))
	adapterhttp.RegisterReads(reads, stampReadsHandler(repo, gateway, log))

	rec := stampGet(t, router, "/v1/trackings/ord_1", stampSub)
	if rec.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 with no Users client wired: %s", rec.Code, rec.Body)
	}
}

// A nil identity cache degrades to a direct resolution rather than to none: the
// read is still enriched and still keyed.
func TestANilIdentityCacheStillResolves(t *testing.T) {
	resolver := &stampResolver{userID: stampUserID}
	gateway := newStampGateway()
	repo := &stampRepo{owner: stampSub}
	log := slog.New(slog.NewJSONHandler(io.Discard, nil))

	router := gin.New()
	reads := router.Group("", adapterhttp.StampResolvedUserID(resolver, nil, log))
	adapterhttp.RegisterReads(reads, stampReadsHandler(repo, gateway, log))

	rec := stampGet(t, router, "/v1/trackings/ord_1", stampSub)
	if rec.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body)
	}
	if calls := resolver.Calls(); calls != 1 {
		t.Errorf("the resolver ran %d times, want 1 — a nil cache must fall through to gRPC", calls)
	}
}
