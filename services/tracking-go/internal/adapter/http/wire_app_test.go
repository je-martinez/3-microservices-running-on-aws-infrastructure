package http_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	nethttp "net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/openapi"
)

// The composition root's tests. Everything here is a MIS-WIRE detector: the
// handlers themselves are covered by their own tests, and what cannot be covered
// there is whether main.go ever calls the seam that mounts them.
//
// Helpers carry the `wire` prefix — Wave 2's five tasks share `package http_test`
// and generic names collided across them (plan correction 11).

// wireStubs are the collaborators AppRouter needs that a wiring test has no
// business supplying for real — each is nil-tolerated or a null object. The pool
// is a non-nil, never-connected *sql.DB (sql.Open does not dial), which is what
// lets the route table be asserted with no MySQL.
func wireStubs(t *testing.T) (*sql.DB, *slog.Logger) {
	t.Helper()

	db, err := sql.Open("mysql", "wire:test@tcp(127.0.0.1:1)/tracking?parseTime=true&loc=UTC")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	return db, slog.New(slog.NewJSONHandler(io.Discard, nil))
}

// wireOptions builds the full option set with the flags a caller wants to vary.
func wireOptions(t *testing.T, e2eEnabled bool) adapterhttp.AppRouterOptions {
	t.Helper()
	db, log := wireStubs(t)

	return adapterhttp.AppRouterOptions{
		WriterDB:          db,
		ReaderDB:          db,
		Gateway:           cache.NewNullGateway(),
		CacheEnabled:      false,
		E2ETestingEnabled: e2eEnabled,
		CarrierAPIKey:     "carrier-key",
		InternalAPIKey:    "internal-key",
		Logger:            log,
	}
}

// wireRoutes returns "METHOD PATH" for every route Gin actually holds.
func wireRoutes(router *gin.Engine) []string {
	var out []string
	for _, route := range router.Routes() {
		out = append(out, route.Method+" "+route.Path)
	}
	sort.Strings(out)
	return out
}

func wireHasRoute(router *gin.Engine, method, path string) bool {
	for _, route := range router.Routes() {
		if route.Method == method && route.Path == path {
			return true
		}
	}
	return false
}

// ─── The seven routes ────────────────────────────────────────────────────────

// TestAppRouterRegistersEverySeam is the whole point of this file.
//
// Asserted against the ROUTE TABLE rather than by issuing seven requests: a
// dropped Register* call is then a failing unit test here, not a gateway E2E
// failure hours later, and the assertion does not depend on any handler's
// collaborators being reachable.
func TestAppRouterRegistersEverySeam(t *testing.T) {
	router := adapterhttp.NewAppRouter(wireOptions(t, true))

	want := []string{
		"DELETE /v1/trackings/by-user",
		"DELETE /v1/trackings/e2e-cleanup",
		"GET /v1/health",
		"GET /v1/trackings",
		"GET /v1/trackings/:order_id",
		"POST /v1/trackings/init-tracking",
		"PUT /v1/trackings/:order_id/status",
	}

	got := wireRoutes(router)
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("route table mismatch\n got:\n%s\nwant:\n%s",
			strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// TestAppRouterDoesNotPanicOnWildcardConflict pins the failure mode that takes
// the PROCESS down rather than one request. Gin panics AT REGISTRATION when a
// literal and a wildcard collide in one method's tree, and the three literals
// here coexist with :order_id only because their methods differ. Constructing
// the router IS the assertion, so a conflicting route fails at its own commit.
func TestAppRouterDoesNotPanicOnWildcardConflict(t *testing.T) {
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("NewAppRouter panicked, a Gin route-tree conflict: %v", recovered)
		}
	}()

	// Both flag positions, because the e2e literal is only registered in one of
	// them and a conflict it caused would be invisible in the other.
	adapterhttp.NewAppRouter(wireOptions(t, true))
	adapterhttp.NewAppRouter(wireOptions(t, false))
}

// ─── The e2e route's conditional registration ────────────────────────────────

func TestE2ECleanupRouteIsAbsentWhenTheFlagIsOff(t *testing.T) {
	router := adapterhttp.NewAppRouter(wireOptions(t, false))

	if wireHasRoute(router, nethttp.MethodDelete, "/v1/trackings/e2e-cleanup") {
		t.Fatal("DELETE /v1/trackings/e2e-cleanup is registered with E2E_TESTING_ENABLED off; " +
			"a route that exists and refuses is still a route — it must not exist at all")
	}
}

// TestE2ECleanupAnswers405WhenTheFlagIsOff is the behavioural half. 405 rather
// than 404 because GET /v1/trackings/:order_id matches that path in another
// method's tree and HandleMethodNotAllowed is on — a 404 here is exactly what
// forgetting that setting produces.
func TestE2ECleanupAnswers405WhenTheFlagIsOff(t *testing.T) {
	router := adapterhttp.NewAppRouter(wireOptions(t, false))

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodDelete,
		"/v1/trackings/e2e-cleanup", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != nethttp.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405 (a 404 means HandleMethodNotAllowed is off)", rec.Code)
	}
}

// ─── Health, end to end through the real router ──────────────────────────────

// TestAppRouterServesHealth proves the wiring produces a router that actually
// answers, not merely one whose table looks right. Health is the one route that
// touches no collaborator, so it is the one that can be exercised here.
func TestAppRouterServesHealth(t *testing.T) {
	router := adapterhttp.NewAppRouter(wireOptions(t, false))

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/v1/health", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, `"status":"ok"`) {
		t.Fatalf("body = %s, want it to carry \"status\":\"ok\"", body)
	}
}

// ─── The middleware order ────────────────────────────────────────────────────

// CONTRACT: gin.Recovery sits OUTSIDE LogContextMiddleware, and the assertion is
// on the LOGGED status code, not the HTTP one — both orders answer 500, so
// asserting the panic escapes passes either way. With Recovery inner it swallows
// the panic before LogContextMiddleware sees it unwinding, so the line is built
// from c.Writer.Status() and a crash after the status is written logs 200:
// invisible in the logs and uncounted in the 5xx metric.
// See [[logging-context]]
func TestRecoverySitsOutsideLogContext(t *testing.T) {
	var logged bytes.Buffer

	opts := wireOptions(t, false)
	opts.Logger = slog.New(slog.NewJSONHandler(&logged, nil))
	router := adapterhttp.NewAppRouter(opts)

	// Panicking AFTER the status is committed is what separates "observed the
	// panic" from "read the response writer". A panic before the first write
	// cannot tell the two orders apart.
	router.GET("/wire-test-panic", func(c *gin.Context) {
		c.Status(nethttp.StatusOK)
		c.Writer.WriteHeaderNow()
		panic("boom")
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/wire-test-panic", nil)
	router.ServeHTTP(rec, req)

	var line map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(logged.Bytes()), &line); err != nil {
		t.Fatalf("no request log line for the panicking request: %v (buffer=%q)", err, logged.String())
	}

	status, _ := line["http_response_status_code"].(float64)
	if int(status) != nethttp.StatusInternalServerError {
		t.Fatalf("logged http_response_status_code = %d, want 500.\n"+
			"A 200 here means gin.Recovery is registered INSIDE LogContextMiddleware: "+
			"it swallows the panic before the log middleware observes it unwinding, so "+
			"the crash is logged as a success and never counted as a 5xx.", int(status))
	}
}

// ─── The identity stamp ──────────────────────────────────────────────────────

// wireCountingResolver counts resolutions so a wiring test can assert WHICH
// routes reach Users. Two different values for the two identities, so it cannot
// pass by echoing the header back.
type wireCountingResolver struct {
	mu    sync.Mutex
	calls int
}

func (r *wireCountingResolver) ResolveInternalUserID(context.Context, string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	return "usr_wire_abc", nil
}

func (r *wireCountingResolver) Calls() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

// TestTheIdentityStampIsAppliedToTheReadsAndNowhereElse asserts NewAppRouter
// actually CALLS StampResolvedUserID, and on which routes — what its own suite
// cannot cover. A dropped group makes the response cache permanently inert while
// every other test here stays green, since each stamps the usr_ id in its own
// fixture. A count of 1 on a request carrying an identity and 0 on the
// identityless routes separates per-route from global.
func TestTheIdentityStampIsAppliedToTheReadsAndNowhereElse(t *testing.T) {
	for _, tc := range []struct {
		name   string
		method string
		target string
		// wantCalls is how many times Users must be reached for this request.
		wantCalls int
	}{
		{"the single read resolves", nethttp.MethodGet, "/v1/trackings/ord_1", 1},
		{"the batch read resolves", nethttp.MethodGet, "/v1/trackings?order_ids=ord_1", 1},
		{"health never resolves", nethttp.MethodGet, "/v1/health", 0},
		{"the carrier PUT never resolves", nethttp.MethodPut, "/v1/trackings/ord_1/status", 0},
		{"the cascade delete never resolves", nethttp.MethodDelete, "/v1/trackings/by-user", 0},
		{"the e2e cleanup never resolves", nethttp.MethodDelete, "/v1/trackings/e2e-cleanup", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resolver := &wireCountingResolver{}
			opts := wireOptions(t, true)
			opts.Users = resolver
			router := adapterhttp.NewAppRouter(opts)

			rec := httptest.NewRecorder()
			req := httptest.NewRequestWithContext(t.Context(), tc.method, tc.target, nil)
			// Sent on EVERY request, the identityless ones included. A middleware
			// guarding merely on "the header is present" would fire on these
			// strays and pay a gRPC call on a request that has no business
			// making one; applying it per-route is what makes that structural.
			req.Header.Set("x-user-id", "sub-wire-owner")
			router.ServeHTTP(rec, req)

			if got := resolver.Calls(); got != tc.wantCalls {
				t.Fatalf("Users was reached %d times on %s %s, want %d",
					got, tc.method, tc.target, tc.wantCalls)
			}
		})
	}
}

// ─── The document and the router describe the SAME service ───────────────────

// TestTheOpenAPIDocumentDescribesExactlyTheseRoutes ties the hand-written spec
// to the route table Gin holds. internal/openapi only proves the document is
// internally consistent — it never sees a gin.Engine — so this is the only
// assertion that fails when the two drift, and it lives here because this
// package can build the real router while openapi imports nothing. It compares
// PATH TEMPLATES, normalizing gin's ":order_id" to OpenAPI's "{order_id}".
func TestTheOpenAPIDocumentDescribesExactlyTheseRoutes(t *testing.T) {
	// E2E on, matching the document: it describes the FULL contract including the
	// flag-guarded cleanup route, the same choice the Python generator makes.
	router := adapterhttp.NewAppRouter(wireOptions(t, true))

	inRouter := map[string]bool{}
	for _, route := range router.Routes() {
		path := strings.ReplaceAll(route.Path, ":order_id", "{order_id}")
		inRouter[strings.ToLower(route.Method)+" "+path] = true
	}

	inDocument := map[string]bool{}
	for path, item := range openapi.BuildSpec()["paths"].(map[string]any) {
		for method := range item.(map[string]any) {
			inDocument[method+" "+path] = true
		}
	}

	for route := range inRouter {
		if !inDocument[route] {
			t.Errorf("%s is served but ABSENT from openapi.yaml — a route people can "+
				"call and no consumer can discover", route)
		}
	}
	for route := range inDocument {
		if !inRouter[route] {
			t.Errorf("%s is documented but NOT SERVED — the contract promises a route "+
				"that answers 404", route)
		}
	}
}
