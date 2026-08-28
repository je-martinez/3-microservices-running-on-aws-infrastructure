package http_test

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	nethttp "net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

// The composition root's tests. Everything here is a MIS-WIRE detector: the
// handlers themselves are covered by their own tests, and what cannot be covered
// there is whether main.go ever calls the seam that mounts them.
//
// Helpers carry the `wire` prefix — Wave 2's five tasks share `package http_test`
// and generic names collided across them (plan correction 11).

// wireStubs are the collaborators AppRouter needs that a wiring test has no
// business supplying for real. Every one is either nil-tolerated by the seam it
// reaches or a null object.
//
// The database pool is a NON-NIL, NEVER-CONNECTED *sql.DB. sql.Open does not
// dial, so this is a legal pool that would only fail on first query — and no
// test here issues one. That is what lets the route table be asserted without
// MySQL, while the repository tests keep using a real server.
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
// the PROCESS down rather than one request.
//
// Gin builds one radix tree PER METHOD and panics AT REGISTRATION when a literal
// and a wildcard collide inside one tree. The three literals here
// (init-tracking, by-user, e2e-cleanup) coexist with :order_id ONLY because their
// methods differ. Constructing the full router is the assertion: a panic fails
// this test at the exact commit that introduced the conflicting route, instead of
// crash-looping a container.
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

// TestE2ECleanupAnswers405WhenTheFlagIsOff is the behavioural half.
//
// 405 rather than 404 BECAUSE GET /v1/trackings/:order_id matches that path in
// another method's tree, and HandleMethodNotAllowed is on. The Python answers 405
// for the same reason (Starlette's default), so a 404 here would be a silent
// behavioural drift the equivalence gate exists to catch — and it is exactly what
// forgetting `router.HandleMethodNotAllowed = true` produces.
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

// TestRecoverySitsOutsideLogContext pins the ORDER of the two middlewares.
//
// # What the order actually changes, measured rather than assumed
//
// The obvious assertion — "the panic escapes if the order is wrong" — DOES NOT
// HOLD, and asserting it yields a test that passes under both orders. Verified
// on gin 1.12.0: LogContextMiddleware's deferred observer never calls recover(),
// so it re-raises only in the sense of letting the panic keep unwinding, and
// gin.Recovery catches a panic from anywhere INSIDE it, on the way out as well
// as on the way in. Either order therefore answers 500 and drops nothing.
//
// The difference is in the OBSERVATION, which is the whole reason the middleware
// watches for panics at all. It shows up on a handler that panics AFTER the
// status is already written:
//
//	Recovery OUTER (correct): the panic unwinds THROUGH LogContextMiddleware,
//	  whose deferred observe() fires with an explicit 500 — the request log line
//	  says 500 and the 5xx metric is counted.
//	Recovery INNER (wrong):   Recovery swallows the panic before
//	  LogContextMiddleware sees it unwinding, so c.Next() returns normally and
//	  the line is built from c.Writer.Status() — 200. The crash is INVISIBLE in
//	  the logs and uncounted in the metric that exists to find it.
//
// So the assertion is on the logged status code, not on the HTTP status.
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
