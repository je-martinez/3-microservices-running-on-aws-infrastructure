package http_test

import (
	"encoding/json"
	"io"
	"log/slog"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
)

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestRequireCallerSubAcceptsAHeader(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	var seen string
	r.GET("/x", adapterhttp.RequireCallerSub(), func(c *gin.Context) {
		seen = adapterhttp.CallerSub(c)
		c.Status(nethttp.StatusOK)
	})

	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/x", nil)
	req.Header.Set("x-user-id", "sub-abc")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if seen != "sub-abc" {
		t.Errorf("CallerSub = %q, want sub-abc", seen)
	}
}

// EMPTY IS MISSING. nginx sets x-user-id to "" when the token is missing or
// malformed; accepting "" would scope a read to cognito_sub = ”, matching
// nothing — a silent empty result instead of the 401 the caller deserves.
func TestRequireCallerSubRejectsAbsentAndEmptyIdentically(t *testing.T) {
	for _, tt := range []struct {
		name  string
		value string
		set   bool
	}{
		{"absent", "", false},
		{"empty string", "", true},
		{"whitespace only", "   ", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			r := gin.New()
			r.GET("/x", adapterhttp.RequireCallerSub(), func(c *gin.Context) { c.Status(nethttp.StatusOK) })

			req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/x", nil)
			if tt.set {
				req.Header.Set("x-user-id", tt.value)
			}
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			if rec.Code != nethttp.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
			var body map[string]any
			_ = json.Unmarshal(rec.Body.Bytes(), &body)
			if body["detail"] != "missing x-user-id" {
				t.Errorf("body = %s, want {\"detail\":\"missing x-user-id\"}", rec.Body.String())
			}
		})
	}
}

// The two x-api-key schemes are DIFFERENT SECRETS IN DIFFERENT TRUST DOMAINS.
// The carrier key must not open the internal route, and vice versa.
func TestCarrierAndInternalKeysAreNotInterchangeable(t *testing.T) {
	const carrierKey = "carrier-secret-value"
	const internalKey = "internal-secret-value"

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.PUT("/carrier", adapterhttp.RequireCarrierKey(carrierKey, discardLogger()),
		func(c *gin.Context) { c.Status(nethttp.StatusOK) })
	r.DELETE("/internal", adapterhttp.RequireInternalKey(internalKey, discardLogger()),
		func(c *gin.Context) { c.Status(nethttp.StatusOK) })

	tests := []struct {
		name       string
		method     string
		path       string
		key        string
		wantStatus int
	}{
		{"carrier route with carrier key", nethttp.MethodPut, "/carrier", carrierKey, nethttp.StatusOK},
		{"carrier route with INTERNAL key", nethttp.MethodPut, "/carrier", internalKey, nethttp.StatusUnauthorized},
		{"internal route with internal key", nethttp.MethodDelete, "/internal", internalKey, nethttp.StatusOK},
		{"internal route with CARRIER key", nethttp.MethodDelete, "/internal", carrierKey, nethttp.StatusUnauthorized},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequestWithContext(t.Context(), tt.method, tt.path, nil)
			req.Header.Set("x-api-key", tt.key)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
		})
	}
}

// Missing and wrong take the IDENTICAL path and produce the IDENTICAL body:
// deliberately indistinguishable.
func TestMissingAndWrongKeysAreIndistinguishable(t *testing.T) {
	for _, mw := range []struct {
		name string
		fn   gin.HandlerFunc
	}{
		{"carrier", adapterhttp.RequireCarrierKey("the-real-key", discardLogger())},
		{"internal", adapterhttp.RequireInternalKey("the-real-key", discardLogger())},
	} {
		t.Run(mw.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			r := gin.New()
			r.GET("/x", mw.fn, func(c *gin.Context) { c.Status(nethttp.StatusOK) })

			var bodies []string
			var statuses []int
			for _, key := range []string{"", "wrong-key", "the-real-ke", "the-real-keyy"} {
				req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, "/x", nil)
				if key != "" {
					req.Header.Set("x-api-key", key)
				}
				rec := httptest.NewRecorder()
				r.ServeHTTP(rec, req)
				statuses = append(statuses, rec.Code)
				bodies = append(bodies, rec.Body.String())
			}

			for i := range statuses {
				if statuses[i] != nethttp.StatusUnauthorized {
					t.Errorf("case %d: status = %d, want 401", i, statuses[i])
				}
				if bodies[i] != bodies[0] {
					t.Errorf("case %d body %q differs from case 0 %q; missing and wrong must be indistinguishable",
						i, bodies[i], bodies[0])
				}
			}
			var body map[string]any
			_ = json.Unmarshal([]byte(bodies[0]), &body)
			if body["detail"] != "invalid api key" {
				t.Errorf("body = %s, want {\"detail\":\"invalid api key\"}", bodies[0])
			}
		})
	}
}

// NEVER log the key — not the value, not a prefix, not its length.
func TestRejectionLogsAReasonAndTheIPButNeverTheKey(t *testing.T) {
	var buf strings.Builder
	log := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.PUT("/x", adapterhttp.RequireCarrierKey("super-secret-carrier-key", log),
		func(c *gin.Context) { c.Status(nethttp.StatusOK) })

	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodPut, "/x", nil)
	req.Header.Set("x-api-key", "attacker-guess-abcdef")
	r.ServeHTTP(httptest.NewRecorder(), req)

	out := buf.String()
	if !strings.Contains(out, "invalid_api_key") {
		t.Errorf("no reason=invalid_api_key in: %s", out)
	}
	if !strings.Contains(out, "client") {
		t.Errorf("the client IP should be logged: %s", out)
	}
	for _, forbidden := range []string{"super-secret-carrier-key", "attacker-guess-abcdef", "super-sec", "attacker-"} {
		if strings.Contains(out, forbidden) {
			t.Errorf("the log line leaked key material %q: %s", forbidden, out)
		}
	}
	// Not even the length.
	if strings.Contains(out, "key_length") || strings.Contains(out, "\"length\"") {
		t.Errorf("the log line reported a key length: %s", out)
	}
}
