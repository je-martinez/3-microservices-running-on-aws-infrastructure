package http_test

import (
	nethttp "net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
)

func e2eResult(t *testing.T, e2eEnabled bool, header string, setHeader bool) bool {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	var got bool
	r.POST("/x", adapterhttp.E2ESourceMiddleware(e2eEnabled), func(c *gin.Context) {
		got = adapterhttp.IsE2ESource(c)
		c.Status(nethttp.StatusOK)
	})

	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodPost, "/x", nil)
	if setHeader {
		req.Header.Set("x-e2e-source", header)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != nethttp.StatusOK {
		t.Fatalf("status = %d; an unrecognized flag value must never fail the request", rec.Code)
	}
	return got
}

// The result is the AND of the header AND the flag. Without the conjunction any
// client could tag its own rows — and that tag is the exact predicate a mass
// soft-delete endpoint selects on.
func TestE2ESourceIsTheAndOfHeaderAndFlag(t *testing.T) {
	tests := []struct {
		name       string
		e2eEnabled bool
		header     string
		setHeader  bool
		want       bool
	}{
		{"flag on, header true", true, "true", true, true},
		{"flag on, header TRUE", true, "TRUE", true, true},
		{"flag on, header padded", true, "  true  ", true, true},
		{"flag OFF, header true", false, "true", true, false},
		{"flag on, no header", true, "", false, false},
		{"flag on, header false", true, "false", true, false},
		// Only the exact string activates it: no 1, no yes.
		{"flag on, header 1", true, "1", true, false},
		{"flag on, header yes", true, "yes", true, false},
		{"flag on, header garbage", true, "maybe", true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := e2eResult(t, tt.e2eEnabled, tt.header, tt.setHeader); got != tt.want {
				t.Errorf("IsE2ESource = %v, want %v", got, tt.want)
			}
		})
	}
}

// The tag written to the DB is exactly "E2E Source" — capital E, capital S, one
// space. Shared verbatim with Users; a near-miss cleans up nothing while looking
// correct.
func TestE2ESourceTagSpelling(t *testing.T) {
	if adapterhttp.E2ESourceTag != "E2E Source" {
		t.Errorf("E2ESourceTag = %q, want exactly \"E2E Source\"", adapterhttp.E2ESourceTag)
	}
}

// x-test-mode uses the same parsing but is deliberately NOT guarded by
// E2E_TESTING_ENABLED in this service. A recorded known open item — do not
// "fix" it here.
func TestTestModeParsingIsUnguarded(t *testing.T) {
	tests := []struct {
		header    string
		setHeader bool
		want      bool
	}{
		{"true", true, true},
		{"TRUE", true, true},
		{"  True  ", true, true},
		{"false", true, false},
		{"1", true, false},
		{"yes", true, false},
		{"", false, false},
	}
	for _, tt := range tests {
		t.Run(tt.header, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			r := gin.New()
			var got bool
			r.POST("/x", adapterhttp.TestModeMiddleware(), func(c *gin.Context) {
				got = adapterhttp.IsTestMode(c)
				c.Status(nethttp.StatusOK)
			})

			req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodPost, "/x", nil)
			if tt.setHeader {
				req.Header.Set("x-test-mode", tt.header)
			}
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			if rec.Code != nethttp.StatusOK {
				t.Fatalf("status = %d; an unrecognized value must never fail the request", rec.Code)
			}
			if got != tt.want {
				t.Errorf("IsTestMode = %v, want %v", got, tt.want)
			}
		})
	}
}
