package http

import (
	"context"
	"log/slog"
	nethttp "net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// CacheHeader is the response header the cached reads stamp (HIT | MISS |
// BYPASS). Its value becomes the log context's cache_result, lowercased.
const CacheHeader = "X-Cache"

// HTTPErrorsMetric is the counter published for every 4xx/5xx response.
//
// Spelled here rather than imported from the cloudwatch adapter on purpose: this
// middleware knows the metric it emits, and depending on that package for a
// string constant would drag an AWS SDK import into the HTTP layer for no gain.
const HTTPErrorsMetric = "http_errors_total"

// serviceDimension is the Service dimension every metric from this service
// carries. Same value the metrics ticker publishes under.
const serviceDimension = "tracking"

// healthRoute is the liveness probe's matched template. Only its 2xx responses
// are exempt from the request log.
const healthRoute = "/v1/health"

// MetricPublisher is the ONE call this middleware makes into metrics, declared
// HERE by the code that consumes it. Narrow by design: the CloudWatch publisher
// satisfies it without this package importing the AWS SDK, and a test double is
// three lines.
//
// It never returns an error, and that is part of the contract rather than an
// implementation detail — the response has already been sent by the time it is
// called, so there is nothing left to fail.
type MetricPublisher interface {
	Publish(ctx context.Context, name string, value float64, dimensions [][2]string)
}

// LogContextMiddleware seeds the per-request log context, emits the one
// `request completed` line, and counts every 4xx/5xx.
//
// # Seeded at the OUTERMOST layer
//
// Before any auth or routing step. The requests someone asks about afterwards
// are disproportionately the ones that did NOT reach a handler — a 401 from the
// api-key check, a 404 from the router — and those are exactly the lines an id
// seeded further in would be missing. Users shipped that precise ordering bug
// (id seeded after the auth guard, so 401s had none) and a test caught it.
//
// # x-user-id is seeded for LOGGING ONLY
//
// It authorizes nothing: rejecting an absent or empty sub is RequireCallerSub's
// job, and seeding a context field never grants access to anything. Note also
// that despite the header's name the value is a Cognito SUB, never the internal
// usr_ id — hence it is merged as cognito_sub and never as user_id.
//
// # Why the metric is published from here
//
// This is the only layer that sees the final status of EVERY response, a router
// 404 included — no handler and no guard ever runs for that one. Only 4xx/5xx
// are counted; a datum per 2xx would be a request-rate metric the request log
// already provides.
func LogContextMiddleware(log *slog.Logger, metrics MetricPublisher) gin.HandlerFunc {
	if log == nil {
		log = slog.Default()
	}
	return func(c *gin.Context) {
		requestID := logging.ResolveRequestID(c.GetHeader(logging.RequestIDHeader))

		ctx := logging.WithLogFields(c.Request.Context(),
			slog.String(logging.KeyRequestID, requestID),
			// Empty is dropped by WithLogFields, so an absent header adds no
			// field rather than an empty one.
			slog.String(logging.KeyCognitoSub, c.GetHeader(UserIDHeader)),
		)
		c.Request = c.Request.WithContext(ctx)

		started := time.Now()

		// A PANIC is the one 5xx this middleware cannot read off the writer:
		// gin.Recovery sits outside it and writes the 500 only after the panic
		// has already unwound past here. Observing it in a deferred function is
		// what keeps the 5xx series from missing exactly the failures it exists
		// to count, and gives the request most worth having a line for its line.
		//
		// The panic is RE-RAISED: producing the error response stays
		// gin.Recovery's job, and swallowing it here would turn a crash into a
		// silent empty 200.
		panicked := true
		defer func() {
			if !panicked {
				return
			}
			observe(c, log, metrics, started, nethttp.StatusInternalServerError)
		}()

		c.Next()
		panicked = false

		observe(c, log, metrics, started, c.Writer.Status())
	}
}

// observe emits the request line and counts the response. Never panics.
func observe(c *gin.Context, log *slog.Logger, metrics MetricPublisher, started time.Time, status int) {
	logRequest(c, log, started, status)
	publishHTTPError(c, log, metrics, status)
}

// logRequest emits the ONE line in this service with no app_event.
//
// INFO for every status, 4xx and 5xx included: the status code already carries
// the outcome, so raising the severity would double-encode it and make an error
// rate computed from severity_text disagree with one computed from
// http_response_status_code.
//
// HEALTH CHECKS ARE THE ONE EXCEPTION, and only while they SUCCEED. Measured:
// 353 of this service's 368 log lines in an hour were GET /v1/health -> 200 —
// 96% of the stream against 2 lines describing actual tracking work. The probe
// runs forever at a fixed interval, so that share only grows on an idle system.
// A succeeding probe is also the one request whose line carries no information;
// a FAILING one carries the status and latency that explain why, so it is logged
// like any other request. Scoped by STATUS rather than by a route list, which is
// what keeps this a rule rather than an allowlist to maintain.
//
// NEVER FAILS THE REQUEST. The response has already been sent (or, on the panic
// path, the original panic is about to continue unwinding), so an observation of
// it must never become the request's failure — nor replace the panic the
// application actually raised.
func logRequest(c *gin.Context, log *slog.Logger, started time.Time, status int) {
	defer func() {
		if recovered := recover(); recovered != nil {
			logFailure(c, log, "request_log_failed", "log_raised", recovered)
		}
	}()

	// FullPath() is the matched TEMPLATE (/v1/trackings/:order_id), not the
	// concrete URL. Logging the raw path would make every order id its own
	// "route" and blow up dashboard cardinality — the field would stop being
	// groupable, which is the only reason it exists.
	//
	// It is empty whenever nothing matched (a 404 from the router), so the raw
	// path is the fallback: those requests still deserve a line, and the
	// cardinality risk is bounded by their hitting no route at all.
	route := c.FullPath()
	if route == "" {
		route = c.Request.URL.Path
	}

	if route == healthRoute && status >= nethttp.StatusOK && status < nethttp.StatusMultipleChoices {
		return
	}

	// THE CACHE RESULT IS MERGED STRAIGHT FROM THE RESPONSE WRITER.
	//
	// The Python original reads X-Cache back off the ASGI wire and merges it in
	// the middleware, because its cached reads are `def` handlers that FastAPI
	// runs in a threadpool worker holding a COPY of the contextvars — a merge
	// performed there is discarded the moment the handler returns, silently.
	// Go has no such trap: a Gin handler shares this request's context.Context,
	// and here the response writer is right at hand. So the header is read
	// directly, with none of that workaround.
	//
	// Absent header means NO field: an uncached route, and every route while
	// CACHE_ENABLED=false, omits cache_result rather than logging a null.
	ctx := logging.WithLogFields(c.Request.Context(),
		slog.String(logging.KeyCacheResult, strings.ToLower(c.Writer.Header().Get(CacheHeader))),
	)

	log.InfoContext(ctx, "request completed",
		slog.String("http_request_method", c.Request.Method),
		slog.String("http_route", route),
		slog.Int("http_response_status_code", status),
		slog.Float64("duration_ms", float64(time.Since(started).Microseconds())/1000.0),
	)
}

// publishHTTPError counts one 4xx/5xx. Never fails the request, for the same
// reason logRequest does not: raising here on the panic path would REPLACE the
// application's original panic with a metrics error.
func publishHTTPError(c *gin.Context, log *slog.Logger, metrics MetricPublisher, status int) {
	if status < nethttp.StatusBadRequest || metrics == nil {
		return
	}

	defer func() {
		if recovered := recover(); recovered != nil {
			logFailure(c, log, "metric_publish_failed", "publish_raised", recovered)
		}
	}()

	class := "4xx"
	if status >= nethttp.StatusInternalServerError {
		class = "5xx"
	}
	metrics.Publish(c.Request.Context(), HTTPErrorsMetric, 1, [][2]string{
		{"Service", serviceDimension},
		{"StatusClass", class},
	})
}

// logFailure reports that an observation of the request failed. Guarded in turn,
// because the reporting path uses the same logger that just failed.
func logFailure(c *gin.Context, log *slog.Logger, appEvent, reason string, recovered any) {
	defer func() { _ = recover() }()

	log.ErrorContext(c.Request.Context(), appEvent,
		slog.String("app_event", appEvent),
		slog.String("reason", reason),
		slog.Any("exception", recovered),
	)
}
