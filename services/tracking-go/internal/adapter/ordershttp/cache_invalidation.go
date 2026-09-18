// Package ordershttp holds this service's outbound HTTP calls to Orders. Its
// own package rather than a file in adapter/http, which is the INBOUND surface:
// one directory named for a protocol would put the carrier webhook's handler and
// the client that calls another service side by side.
package ordershttp

import (
	"context"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

const (
	// The two halves of Orders' path, order id escaped between them.
	//
	// CONTRACT: POST, no body, x-api-key only. Orders resolves the owner from
	// its own order row and sweeps its own key index, so the key format never
	// crosses this seam — do not add a cognito_sub, a user_id or a key here.
	// See [[x-cache-response-header]]
	pathPrefix = "/v1/orders/"
	pathSuffix = "/cache-invalidation"

	// DefaultTimeout is the whole budget for this call, mirroring how Orders
	// budgets its decorating read of Tracking. It runs after a committed write,
	// on a webhook an external carrier is waiting on, so a slow or down Orders
	// must cost a bounded fraction of the response and then be abandoned.
	DefaultTimeout = 2 * time.Second

	appEventSucceeded = "orders_cache_invalidation_succeeded"
	appEventFailed    = "orders_cache_invalidation_failed"
)

// CacheInvalidator asks Orders to forget its cached responses for one order.
//
// It satisfies app.OrderCacheInvalidator: no error is returned anywhere, because
// the transition this follows is already committed and a cache sweep that can
// fail a carrier webhook is a liability rather than an optimization.
type CacheInvalidator struct {
	baseURL string
	apiKey  string
	log     *slog.Logger
	client  *http.Client
}

// NewCacheInvalidator wires the client with the production timeout.
//
// CONTRACT: apiKey is INTERNAL_API_KEY, the INTERNAL credential. Passing
// TRACKING_CARRIER_API_KEY hands an outside vendor's secret to an internal
// surface, which is the widest blast radius this service has.
// See [[two-api-keys-two-trust-domains]]
func NewCacheInvalidator(baseURL, apiKey string, log *slog.Logger) *CacheInvalidator {
	return NewCacheInvalidatorWithTimeout(baseURL, apiKey, log, DefaultTimeout)
}

// NewCacheInvalidatorWithTimeout is the injectable-budget form the timeout test
// uses, so the suite proves the bound without waiting the production one.
func NewCacheInvalidatorWithTimeout(
	baseURL, apiKey string, log *slog.Logger, timeout time.Duration,
) *CacheInvalidator {
	if log == nil {
		log = slog.Default()
	}
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return &CacheInvalidator{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		apiKey:  apiKey,
		log:     log,
		// The timeout lives on the client as well as on the context below: the
		// context bounds the call this service makes, the client bounds a
		// response whose body stalls mid-read.
		client: &http.Client{Timeout: timeout},
	}
}

// InvalidateOrderCache posts the order id to Orders and returns nothing.
//
// CONTRACT: FAIL-OPEN on every outcome, 404 included. A 404 means Orders does
// not know this order, which no retry fixes; every other failure leaves Orders'
// entry to expire by its own TTL. Neither may turn a committed status update
// into a 500 the carrier retries — the forward-only guard then rejects the retry
// as a 400, a permanent-looking failure for a write that succeeded.
// See [[x-cache-response-header]]
func (i *CacheInvalidator) InvalidateOrderCache(ctx context.Context, orderID string) {
	if i.baseURL == "" {
		// A runtime with no ORDERS_BASE_URL is a legal degraded wiring, like a
		// nil publisher. Dialing a nonsense host on every transition would spend
		// the timeout for nothing.
		i.log.DebugContext(ctx, appEventFailed,
			slog.String("app_event", appEventFailed),
			slog.String("reason", "orders_base_url_unset"),
			slog.String("order_id", orderID))
		return
	}

	endpoint := i.baseURL + pathPrefix + url.PathEscape(orderID) + pathSuffix

	// CONTRACT: Derive the deadline from the CALLER's context, never from
	// context.Background(). This call completes before the response is written,
	// so the request context is still live; detaching it would leak the call past
	// a client that already hung up, and inheriting it past the response would be
	// the opposite bug. See [[logging-context]]
	callCtx, cancel := context.WithTimeout(ctx, i.client.Timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, nil)
	if err != nil {
		i.fail(ctx, orderID, "request_build_failed", err.Error())
		return
	}
	req.Header.Set("x-api-key", i.apiKey)
	// Without injection Orders opens a second, unrelated trace and the sweep
	// cannot be found from the carrier PUT's waterfall.
	otel.GetTextMapPropagator().Inject(callCtx, propagation.HeaderCarrier(req.Header))

	resp, err := i.client.Do(req)
	if err != nil {
		// WARNING: err carries the URL, never the key — Go does not put headers
		// in a transport error.
		i.fail(ctx, orderID, "orders_unreachable", err.Error())
		return
	}
	defer func() { _ = resp.Body.Close() }()

	switch resp.StatusCode {
	case http.StatusOK:
		i.log.InfoContext(ctx, appEventSucceeded,
			slog.String("app_event", appEventSucceeded),
			slog.String("order_id", orderID))
	case http.StatusNotFound:
		// Orders does not know this order. Non-fatal and non-retryable, so it is
		// a warning rather than an error: nothing downstream is broken and no
		// operator action follows.
		i.log.WarnContext(ctx, appEventFailed,
			slog.String("app_event", appEventFailed),
			slog.String("reason", "order_not_found"),
			slog.String("order_id", orderID))
	default:
		i.fail(ctx, orderID, "orders_rejected", resp.Status)
	}
}

// fail logs one machine-readable reason and returns.
//
// WARNING: Never widen detail to the response body. Orders' bodies are its own,
// and a body echoed into a log is how a request payload reaches the collector.
func (i *CacheInvalidator) fail(ctx context.Context, orderID, reason, detail string) {
	i.log.ErrorContext(ctx, appEventFailed,
		slog.String("app_event", appEventFailed),
		slog.String("reason", reason),
		slog.String("order_id", orderID),
		slog.String("exception", detail))
}
