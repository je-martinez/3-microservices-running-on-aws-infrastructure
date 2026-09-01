package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestMain(m *testing.M) {
	gin.SetMode(gin.TestMode)
	m.Run()
}

func TestHealthReturns200AndExactBody(t *testing.T) {
	router := NewRouter()

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/v1/health", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	// The body is exactly {"status":"ok"} — no extra fields, no whitespace
	// differences that a consumer's strict parser would trip on.
	if got := rec.Body.String(); got != `{"status":"ok"}` {
		t.Fatalf("body = %s, want %s", got, `{"status":"ok"}`)
	}

	var decoded map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("body is not valid JSON: %v", err)
	}
	if len(decoded) != 1 {
		t.Fatalf("body has %d fields, want exactly 1: %v", len(decoded), decoded)
	}
	if decoded["status"] != "ok" {
		t.Fatalf(`status = %v, want "ok"`, decoded["status"])
	}
}

// The route is served UNPREFIXED. The gateway publishes it as
// /v1/tracking/health and nginx rewrites down to the bare path. A service that
// also served the prefixed path would mask a broken rewrite.
func TestHealthIsServedUnprefixed(t *testing.T) {
	router := NewRouter()

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/v1/tracking/health", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /v1/tracking/health status = %d, want %d — the service serves the BARE path only",
			rec.Code, http.StatusNotFound)
	}
}

// Health carries no auth dependency: an ALB/Fargate probe sends neither an
// x-user-id header nor an API key.
func TestHealthRequiresNoAuthHeaders(t *testing.T) {
	router := NewRouter()

	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/v1/health", nil)
	req.Header.Del("x-user-id")
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status without auth headers = %d, want %d", rec.Code, http.StatusOK)
	}
}

// 200 is the ONLY status this route ever returns.
func TestHealthRejectsOtherMethods(t *testing.T) {
	router := NewRouter()

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		t.Run(method, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequestWithContext(t.Context(), method, "/v1/health", nil)
			router.ServeHTTP(rec, req)

			// HandleMethodNotAllowed is enabled, so a path that exists under a
			// different method answers 405, not 404.
			if rec.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s /v1/health status = %d, want %d", method, rec.Code, http.StatusMethodNotAllowed)
			}
		})
	}
}

// Gin's default is false, which answers 404 where the Python answered 405.
func TestRouterHandlesMethodNotAllowed(t *testing.T) {
	router := NewRouter()
	if !router.HandleMethodNotAllowed {
		t.Fatal("HandleMethodNotAllowed = false; the Python surface answers 405, not 404, for a path under the wrong method")
	}
}

// Today's literals differ in METHOD from the GET wildcard, so they occupy
// different route trees and cannot conflict. Registering them must not panic.
// Adding any GET literal under /v1/trackings/ WOULD panic at startup.
func TestRouteRegistrationDoesNotPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("route registration panicked: %v", r)
		}
	}()

	router := NewRouter()
	noop := func(c *gin.Context) { c.Status(http.StatusOK) }

	router.POST("/v1/trackings/init-tracking", noop)
	router.DELETE("/v1/trackings/by-user", noop)
	router.DELETE("/v1/trackings/e2e-cleanup", noop)
	router.GET("/v1/trackings/:order_id", noop)
}
