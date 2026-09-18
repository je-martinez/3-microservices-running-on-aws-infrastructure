package ordershttp_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/ordershttp"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
)

// capture collects what the fake Orders received, so the assertions can be about
// the request rather than about the client's internals.
type capture struct {
	mu      sync.Mutex
	calls   int
	method  string
	path    string
	rawURI  string
	apiKey  string
	headers http.Header
	body    string
}

func (c *capture) record(r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	c.method = r.Method
	c.path = r.URL.Path
	c.rawURI = r.RequestURI
	c.apiKey = r.Header.Get("x-api-key")
	c.headers = r.Header.Clone()
	raw, _ := io.ReadAll(r.Body)
	c.body = string(raw)
}

func (c *capture) snapshot() capture {
	c.mu.Lock()
	defer c.mu.Unlock()
	return capture{calls: c.calls, method: c.method, path: c.path, rawURI: c.rawURI,
		apiKey: c.apiKey, headers: c.headers, body: c.body}
}

// discardLogger keeps a failing call's log line out of the test output while
// still exercising every logging branch.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

func TestCacheInvalidatorSatisfiesTheUseCasePort(t *testing.T) {
	var _ app.OrderCacheInvalidator = ordershttp.NewCacheInvalidator(
		"http://orders:8080", "internal-key", discardLogger())
}

func TestCacheInvalidatorPostsTheOrderIDAndNothingElse(t *testing.T) {
	got := &capture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.record(r)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"orderId":"ord_1"}`))
	}))
	defer srv.Close()

	inv := ordershttp.NewCacheInvalidator(srv.URL, "internal-key", discardLogger())
	inv.InvalidateOrderCache(context.Background(), "ord_1")

	c := got.snapshot()
	if c.calls != 1 {
		t.Fatalf("Orders received %d calls, want exactly 1", c.calls)
	}
	if c.method != http.MethodPost {
		t.Errorf("method = %s, want POST", c.method)
	}
	if want := "/v1/orders/ord_1/cache-invalidation"; c.path != want {
		t.Errorf("path = %s, want %s", c.path, want)
	}
	if c.apiKey != "internal-key" {
		t.Errorf("x-api-key = %q, want the internal key", c.apiKey)
	}
	if strings.TrimSpace(c.body) != "" {
		t.Errorf("body = %q, want empty — the contract sends none", c.body)
	}

	// CONTRACT: The key shape never leaves Orders, so no identity may travel.
	// A sub or a usr_ id here would let Tracking start building Orders' keys.
	for _, forbidden := range []string{"x-user-id", "x-cognito-sub"} {
		if v := c.headers.Get(forbidden); v != "" {
			t.Errorf("request carried %s=%q; only the order id may cross this seam", forbidden, v)
		}
	}
	for _, forbidden := range []string{"cognito_sub", "user_id", "usr_", "sub-"} {
		if strings.Contains(c.body, forbidden) {
			t.Errorf("body mentions %q; only the order id may cross this seam", forbidden)
		}
	}
}

func TestCacheInvalidatorPresentsTheInternalKeyNotTheCarrierKey(t *testing.T) {
	// The two x-api-key schemes are two trust domains. Handing Orders the
	// carrier's key would authenticate an external vendor's secret against an
	// internal surface. See [[two-api-keys-two-trust-domains]]
	got := &capture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.record(r)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"orderId":"ord_1"}`))
	}))
	defer srv.Close()

	inv := ordershttp.NewCacheInvalidator(srv.URL, "the-internal-grpc-key", discardLogger())
	inv.InvalidateOrderCache(context.Background(), "ord_1")

	if got.snapshot().apiKey != "the-internal-grpc-key" {
		t.Errorf("x-api-key = %q, want the internal key it was constructed with",
			got.snapshot().apiKey)
	}
}

func TestCacheInvalidatorIsFailOpen(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"404 order_not_found is non-fatal and non-retryable", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"order_not_found"}`))
		}},
		{"401 on a wrong key", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
		}},
		{"500 from Orders", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}},
		{"a body that is not JSON at all", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("<html>gateway</html>"))
		}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(tc.handler)
			defer srv.Close()

			inv := ordershttp.NewCacheInvalidator(srv.URL, "internal-key", discardLogger())
			// No panic, no error to return: the transition is already committed.
			inv.InvalidateOrderCache(context.Background(), "ord_1")
		})
	}
}

func TestCacheInvalidatorSurvivesAnUnreachableOrders(t *testing.T) {
	// A closed listener, so the dial itself fails rather than the response.
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close()

	inv := ordershttp.NewCacheInvalidator(url, "internal-key", discardLogger())
	inv.InvalidateOrderCache(context.Background(), "ord_1")
}

func TestCacheInvalidatorAbandonsASlowOrders(t *testing.T) {
	// The property that matters on the carrier's write path: a hung Orders must
	// cost a bounded wait, never the carrier's whole request.
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-release
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	defer close(release)

	inv := ordershttp.NewCacheInvalidatorWithTimeout(
		srv.URL, "internal-key", discardLogger(), 50*time.Millisecond)

	done := make(chan time.Duration, 1)
	go func() {
		start := time.Now()
		inv.InvalidateOrderCache(context.Background(), "ord_1")
		done <- time.Since(start)
	}()

	select {
	case elapsed := <-done:
		if elapsed > 2*time.Second {
			t.Errorf("a hung Orders blocked for %v; the timeout did not bound it", elapsed)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a hung Orders blocked the carrier's status update indefinitely — " +
			"the write is already committed and the carrier is an external party")
	}
}

func TestCacheInvalidatorIsInertWithoutABaseURL(t *testing.T) {
	// A runtime with no ORDERS_BASE_URL is a legal degraded wiring, exactly as a
	// nil publisher is. It must not dial a nonsense host on every transition.
	inv := ordershttp.NewCacheInvalidator("", "internal-key", discardLogger())
	inv.InvalidateOrderCache(context.Background(), "ord_1")
}

func TestCacheInvalidatorPropagatesTheTraceContext(t *testing.T) {
	got := &capture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.record(r)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// A recording span, so the propagator has something to serialize. Without
	// injection Orders' handler opens a second, unrelated trace and the sweep
	// cannot be found from the carrier PUT's waterfall.
	otel.SetTextMapPropagator(propagation.TraceContext{})
	provider := sdktrace.NewTracerProvider()
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	ctx, span := provider.Tracer("test").Start(context.Background(), "carrier_status_update")
	defer span.End()

	inv := ordershttp.NewCacheInvalidator(srv.URL, "internal-key", discardLogger())
	inv.InvalidateOrderCache(ctx, "ord_1")

	traceparent := got.snapshot().headers.Get("traceparent")
	if traceparent == "" {
		t.Fatal("no traceparent reached Orders: the invalidation renders as its own " +
			"root trace instead of a child of the carrier PUT")
	}
	if id := span.SpanContext().TraceID().String(); !strings.Contains(traceparent, id) {
		t.Errorf("traceparent %q does not carry the caller's trace id %s", traceparent, id)
	}
}

func TestCacheInvalidatorEscapesTheOrderIDIntoThePath(t *testing.T) {
	// The id reaches this adapter from a database row, but a path built by
	// concatenation is one bad row away from a request to another route.
	got := &capture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.record(r)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	inv := ordershttp.NewCacheInvalidator(srv.URL, "internal-key", discardLogger())
	inv.InvalidateOrderCache(context.Background(), "ord_1/../by-user")

	// Assert on the RAW request line, not r.URL.Path: net/http DECODES %2F back
	// into a slash there, so a correctly-escaped request reads as a traversal.
	// What Orders routes on is the escaped form.
	uri := got.snapshot().rawURI
	if !strings.Contains(uri, "%2F") {
		t.Errorf("request line = %s: the order id was not escaped into one path segment", uri)
	}
	if want := "/v1/orders/ord_1%2F..%2Fby-user/cache-invalidation"; uri != want {
		t.Errorf("request line = %s, want %s", uri, want)
	}
}

func TestCacheInvalidatorLogsWithoutTheKey(t *testing.T) {
	var sink strings.Builder
	log := slog.New(slog.NewJSONHandler(&sink, &slog.HandlerOptions{Level: slog.LevelDebug}))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"order_not_found"}`))
	}))
	defer srv.Close()

	inv := ordershttp.NewCacheInvalidator(srv.URL, "super-secret-key", log)
	inv.InvalidateOrderCache(context.Background(), "ord_1")

	out := sink.String()
	if strings.Contains(out, "super-secret-key") {
		t.Error("the API key reached a log line")
	}
	if !strings.Contains(out, "ord_1") {
		t.Error("the log line does not name the order whose invalidation failed")
	}
	if !strings.Contains(out, "order_not_found") {
		t.Error("the log line carries no machine-readable reason")
	}

	// One JSON object per line, and app_event present: an unparseable line is
	// filed as `unclassified` by the collector.
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("log line is not JSON: %v", err)
		}
		if _, ok := record["app_event"]; !ok {
			t.Errorf("log record %v carries no app_event", record)
		}
	}
}
