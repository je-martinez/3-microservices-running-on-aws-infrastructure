package http_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	nethttp "net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

var reqIDShape = regexp.MustCompile(`^req_[A-Za-z0-9]{24}$`)

// recordingPublisher satisfies cloudwatch.Publisher structurally without
// importing the SDK: the middleware declares its own narrow port, so the test
// double is three lines.
type recordingPublisher struct {
	mu   sync.Mutex
	data []publishedMetric
}

type publishedMetric struct {
	name       string
	value      float64
	dimensions [][2]string
}

func (p *recordingPublisher) Publish(_ context.Context, name string, value float64, dimensions [][2]string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.data = append(p.data, publishedMetric{name: name, value: value, dimensions: dimensions})
}

func (p *recordingPublisher) published() []publishedMetric {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]publishedMetric(nil), p.data...)
}

// dimension returns the value of a published datum's named dimension.
func (m publishedMetric) dimension(name string) string {
	for _, d := range m.dimensions {
		if d[0] == name {
			return d[1]
		}
	}
	return ""
}

// lines returns every JSON object written to buf.
func lines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, raw := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if raw == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			t.Fatalf("bad JSON line %q: %v", raw, err)
		}
		out = append(out, m)
	}
	return out
}

// findRequestLine returns the one line whose message is "request completed".
func findRequestLine(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	for _, m := range lines(t, buf) {
		if m["message"] == "request completed" {
			return m
		}
	}
	t.Fatalf("no 'request completed' line in:\n%s", buf.String())
	return nil
}

func testLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(logging.NewContextHandler(
		logging.NewHandler(buf, "tracking", "local", slog.LevelDebug)))
}

func newEngine(buf *bytes.Buffer, metrics *recordingPublisher) *gin.Engine {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.Use(adapterhttp.LogContextMiddleware(testLogger(buf), metrics))
	r.GET("/v1/health", func(c *gin.Context) { c.JSON(nethttp.StatusOK, gin.H{"status": "ok"}) })
	r.GET("/v1/trackings/:order_id", func(c *gin.Context) { c.JSON(nethttp.StatusOK, gin.H{}) })
	r.GET("/v1/boom", func(c *gin.Context) { c.JSON(nethttp.StatusInternalServerError, gin.H{}) })
	r.GET("/v1/denied", func(c *gin.Context) { c.JSON(nethttp.StatusForbidden, gin.H{}) })
	return r
}

func get(t *testing.T, r *gin.Engine, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodGet, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestRequestLineShape(t *testing.T) {
	var buf bytes.Buffer
	r := newEngine(&buf, &recordingPublisher{})

	get(t, r, "/v1/trackings/ord_abc123", nil)

	got := findRequestLine(t, &buf)
	if got["http_request_method"] != "GET" {
		t.Errorf("http_request_method = %v, want GET", got["http_request_method"])
	}
	// The matched TEMPLATE, never the concrete URL — cardinality.
	if got["http_route"] != "/v1/trackings/:order_id" {
		t.Errorf("http_route = %v, want the template /v1/trackings/:order_id", got["http_route"])
	}
	if got["http_response_status_code"] != float64(200) {
		t.Errorf("http_response_status_code = %v, want 200", got["http_response_status_code"])
	}
	if _, present := got["duration_ms"]; !present {
		t.Error("duration_ms missing")
	}
	// It is the ONE line with no app_event.
	if _, present := got["app_event"]; present {
		t.Errorf("the request line must carry no app_event, got %v", got["app_event"])
	}
}

// INFO for every status, 4xx and 5xx included. The status carries the outcome.
func TestRequestLineIsINFOForEveryStatus(t *testing.T) {
	for _, tt := range []struct {
		path       string
		wantStatus float64
	}{
		{"/v1/trackings/ord_1", 200},
		{"/v1/nowhere", 404},
		{"/v1/boom", 500},
	} {
		t.Run(tt.path, func(t *testing.T) {
			var buf bytes.Buffer
			r := newEngine(&buf, &recordingPublisher{})
			get(t, r, tt.path, nil)

			got := findRequestLine(t, &buf)
			if got["severity_text"] != "INFO" {
				t.Errorf("severity_text = %v, want INFO for status %v", got["severity_text"], tt.wantStatus)
			}
			if got["http_response_status_code"] != tt.wantStatus {
				t.Errorf("status = %v, want %v", got["http_response_status_code"], tt.wantStatus)
			}
		})
	}
}

// A SUCCEEDING health probe is not logged: 353 of 368 lines in an hour.
func TestHealthCheckSuccessIsNotLogged(t *testing.T) {
	var buf bytes.Buffer
	r := newEngine(&buf, &recordingPublisher{})
	get(t, r, "/v1/health", nil)

	for _, m := range lines(t, &buf) {
		if m["message"] == "request completed" {
			t.Fatalf("a successful /v1/health probe was logged: %v", m)
		}
	}
}

// A FAILING probe carries the status and latency that explain why, so it is
// logged like any other request. The exemption is scoped by STATUS, not route.
func TestFailingHealthCheckIsLogged(t *testing.T) {
	var buf bytes.Buffer
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.Use(adapterhttp.LogContextMiddleware(testLogger(&buf), &recordingPublisher{}))
	r.GET("/v1/health", func(c *gin.Context) {
		c.JSON(nethttp.StatusServiceUnavailable, gin.H{"status": "down"})
	})
	get(t, r, "/v1/health", nil)

	got := findRequestLine(t, &buf)
	if got["http_response_status_code"] != float64(503) {
		t.Errorf("a failing probe must be logged, got status %v", got["http_response_status_code"])
	}
}

// An inbound id of our own shape is honoured.
func TestInboundRequestIDIsHonoured(t *testing.T) {
	var buf bytes.Buffer
	r := newEngine(&buf, &recordingPublisher{})

	get(t, r, "/v1/trackings/ord_1", map[string]string{
		"x-request-id": "req_7gK3mP1vXz9wLq2bN8rRt4Yc",
	})

	got := findRequestLine(t, &buf)
	if got["request_id"] != "req_7gK3mP1vXz9wLq2bN8rRt4Yc" {
		t.Errorf("request_id = %v, want the inbound id", got["request_id"])
	}
}

// A malformed one is silently replaced — never a 400.
func TestMalformedInboundRequestIDIsReplacedNotRejected(t *testing.T) {
	var buf bytes.Buffer
	r := newEngine(&buf, &recordingPublisher{})

	rec := get(t, r, "/v1/trackings/ord_1", map[string]string{
		"x-request-id": "'; DROP TABLE tracking; --",
	})

	if rec.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200: a malformed correlation header must never fail the request", rec.Code)
	}
	got := findRequestLine(t, &buf)
	id, _ := got["request_id"].(string)
	if !reqIDShape.MatchString(id) {
		t.Errorf("request_id = %q, want a freshly minted id", id)
	}
}

// The sub is seeded from x-user-id for LOGGING only — it authorizes nothing.
func TestCognitoSubIsSeededFromHeader(t *testing.T) {
	var buf bytes.Buffer
	r := newEngine(&buf, &recordingPublisher{})

	get(t, r, "/v1/trackings/ord_1", map[string]string{"x-user-id": "sub-abc"})

	got := findRequestLine(t, &buf)
	if got["cognito_sub"] != "sub-abc" {
		t.Errorf("cognito_sub = %v, want sub-abc", got["cognito_sub"])
	}
}

// Absent header means NO field — omitted, never null and never "".
func TestAbsentCognitoSubIsOmitted(t *testing.T) {
	var buf bytes.Buffer
	r := newEngine(&buf, &recordingPublisher{})

	get(t, r, "/v1/trackings/ord_1", nil)

	got := findRequestLine(t, &buf)
	if value, present := got["cognito_sub"]; present {
		t.Errorf("cognito_sub present as %v with no x-user-id header, want the field omitted", value)
	}
}

// An id is seeded even on requests that never reach a handler — those are
// disproportionately the ones someone asks about afterwards.
func TestRequestIDIsSeededOnA404(t *testing.T) {
	var buf bytes.Buffer
	r := newEngine(&buf, &recordingPublisher{})
	get(t, r, "/v1/nowhere", nil)

	got := findRequestLine(t, &buf)
	id, _ := got["request_id"].(string)
	if !reqIDShape.MatchString(id) {
		t.Errorf("request_id = %q on a 404, want a minted id", id)
	}
}

// Seeded at the OUTERMOST layer: a 401 from an auth guard registered AFTER this
// middleware still carries an id and the sub. Users shipped the opposite
// ordering and 401s had no id at all.
func TestRequestIDIsSeededOnA401FromALaterGuard(t *testing.T) {
	var buf bytes.Buffer
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.Use(adapterhttp.LogContextMiddleware(testLogger(&buf), &recordingPublisher{}))
	r.GET("/v1/guarded", adapterhttp.RequireCarrierKey("expected-key", testLogger(&buf)),
		func(c *gin.Context) { c.Status(nethttp.StatusOK) })

	rec := get(t, r, "/v1/guarded", map[string]string{"x-user-id": "sub-abc"})
	if rec.Code != nethttp.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}

	got := findRequestLine(t, &buf)
	id, _ := got["request_id"].(string)
	if !reqIDShape.MatchString(id) {
		t.Errorf("request_id = %q on a 401, want a minted id", id)
	}
	if got["cognito_sub"] != "sub-abc" {
		t.Errorf("cognito_sub = %v on a 401, want sub-abc", got["cognito_sub"])
	}
}

// The X-Cache header the cached reads stamp becomes cache_result, LOWERCASED.
func TestCacheResultIsCapturedLowercased(t *testing.T) {
	for _, header := range []string{"HIT", "MISS", "BYPASS"} {
		t.Run(header, func(t *testing.T) {
			var buf bytes.Buffer
			gin.SetMode(gin.TestMode)

			r := gin.New()
			r.Use(adapterhttp.LogContextMiddleware(testLogger(&buf), &recordingPublisher{}))
			r.GET("/v1/trackings/:order_id", func(c *gin.Context) {
				c.Header("X-Cache", header)
				c.JSON(nethttp.StatusOK, gin.H{})
			})
			get(t, r, "/v1/trackings/ord_1", nil)

			got := findRequestLine(t, &buf)
			want := strings.ToLower(header)
			if got["cache_result"] != want {
				t.Errorf("cache_result = %v, want %q", got["cache_result"], want)
			}
		})
	}
}

// No X-Cache header (an uncached route, or CACHE_ENABLED=false) means NO field.
// Omitted, never null and never "".
func TestAbsentCacheHeaderOmitsCacheResult(t *testing.T) {
	var buf bytes.Buffer
	r := newEngine(&buf, &recordingPublisher{})

	get(t, r, "/v1/trackings/ord_1", nil)

	got := findRequestLine(t, &buf)
	if value, present := got["cache_result"]; present {
		t.Errorf("cache_result present as %v with no X-Cache header, want the field omitted", value)
	}
}

// Every 4xx and 5xx is counted, with the class as a dimension.
func TestHTTPErrorsAreCounted(t *testing.T) {
	for _, tt := range []struct {
		path      string
		wantClass string
	}{
		{"/v1/denied", "4xx"},
		{"/v1/nowhere", "4xx"},
		{"/v1/boom", "5xx"},
	} {
		t.Run(tt.path, func(t *testing.T) {
			var buf bytes.Buffer
			metrics := &recordingPublisher{}
			r := newEngine(&buf, metrics)
			get(t, r, tt.path, nil)

			published := metrics.published()
			if len(published) != 1 {
				t.Fatalf("published %d data points, want exactly 1: %+v", len(published), published)
			}
			datum := published[0]
			if datum.name != "http_errors_total" {
				t.Errorf("metric name = %q, want http_errors_total", datum.name)
			}
			if datum.value != 1 {
				t.Errorf("value = %v, want 1", datum.value)
			}
			if got := datum.dimension("StatusClass"); got != tt.wantClass {
				t.Errorf("StatusClass = %q, want %q", got, tt.wantClass)
			}
			if got := datum.dimension("Service"); got != "tracking" {
				t.Errorf("Service = %q, want tracking", got)
			}
		})
	}
}

// A 2xx publishes NOTHING: a metric per success would be a request-rate metric
// the request log already provides.
func TestSuccessPublishesNoErrorMetric(t *testing.T) {
	var buf bytes.Buffer
	metrics := &recordingPublisher{}
	r := newEngine(&buf, metrics)
	get(t, r, "/v1/trackings/ord_1", nil)

	if published := metrics.published(); len(published) != 0 {
		t.Fatalf("a 200 published %+v, want nothing", published)
	}
}

// An unhandled panic is the one 5xx the middleware cannot read off the writer
// when it re-raises, so it is counted as 500 explicitly — and the request still
// gets its line before the panic continues to gin.Recovery.
func TestPanicIsLoggedCountedAndReRaised(t *testing.T) {
	var buf bytes.Buffer
	metrics := &recordingPublisher{}
	gin.SetMode(gin.TestMode)

	r := gin.New()
	// Recovery OUTSIDE, so the panic passes through the log middleware first.
	r.Use(gin.Recovery())
	r.Use(adapterhttp.LogContextMiddleware(testLogger(&buf), metrics))
	r.GET("/v1/panic", func(_ *gin.Context) { panic("boom") })

	rec := get(t, r, "/v1/panic", nil)
	if rec.Code != nethttp.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 — the panic must still reach gin.Recovery", rec.Code)
	}

	got := findRequestLine(t, &buf)
	if got["http_response_status_code"] != float64(500) {
		t.Errorf("status = %v on a panic, want 500", got["http_response_status_code"])
	}

	published := metrics.published()
	if len(published) != 1 {
		t.Fatalf("published %d data points on a panic, want exactly 1: %+v", len(published), published)
	}
	if got := published[0].dimension("StatusClass"); got != "5xx" {
		t.Errorf("StatusClass = %q on a panic, want 5xx", got)
	}
}

// panickingHandler fails the FIRST emission and then behaves, which is how a
// logging failure can actually break a request in Go: slog discards the error a
// Handler returns, so a panic in the emission path is the only failure that
// propagates to the caller.
type panickingHandler struct {
	inner  slog.Handler
	panics int
}

func (h *panickingHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *panickingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &panickingHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h *panickingHandler) WithGroup(name string) slog.Handler {
	return &panickingHandler{inner: h.inner.WithGroup(name)}
}

func (h *panickingHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Message == "request completed" {
		h.panics++
		panic("log handler exploded")
	}
	return h.inner.Handle(ctx, r)
}

// Logging must NEVER break the request: a failure emitting the line is itself
// logged (request_log_failed / log_raised) and the response stands.
func TestLoggingFailureNeverBreaksTheRequest(t *testing.T) {
	gin.SetMode(gin.TestMode)

	var buf bytes.Buffer
	handler := &panickingHandler{inner: logging.NewContextHandler(
		logging.NewHandler(&buf, "tracking", "local", slog.LevelDebug))}
	log := slog.New(handler)

	r := gin.New()
	r.Use(adapterhttp.LogContextMiddleware(log, &recordingPublisher{}))
	r.GET("/v1/trackings/:order_id", func(c *gin.Context) { c.JSON(nethttp.StatusOK, gin.H{}) })

	rec := get(t, r, "/v1/trackings/ord_1", nil)
	if rec.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 — a logging failure must never fail the request", rec.Code)
	}
	if handler.panics == 0 {
		t.Fatal("the handler never panicked; the test proves nothing")
	}

	var failure map[string]any
	for _, m := range lines(t, &buf) {
		if m["app_event"] == "request_log_failed" {
			failure = m
		}
	}
	if failure == nil {
		t.Fatalf("no request_log_failed line in:\n%s", buf.String())
	}
	if failure["reason"] != "log_raised" {
		t.Errorf("reason = %v, want log_raised", failure["reason"])
	}
}
