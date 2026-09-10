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
// here by its consumer so the CloudWatch publisher satisfies it without this
// package importing the AWS SDK. It returns no error by contract: the response
// is already sent by the time it runs, so there is nothing left to fail.
type MetricPublisher interface {
	Publish(ctx context.Context, name string, value float64, dimensions [][2]string)
}

// LogContextMiddleware seeds the per-request log context, emits the one
// `request completed` line, and counts every 4xx/5xx.
//
// CONTRACT: Register this OUTERMOST, before any auth or routing step. The
// requests asked about later are the ones that never reached a handler (a 401
// from the key check, a 404 from the router), and an id seeded further in is
// missing from exactly those lines. The metric is published here for the same
// reason: only this layer sees every response's final status.
//
// CONTRACT: x-user-id is seeded for LOGGING ONLY and authorizes nothing. It
// holds a Cognito SUB despite its name, so it merges as cognito_sub.
// See [[logging-context]]
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

		// CONTRACT: Observe a panic from this deferred function and RE-RAISE it.
		// gin.Recovery sits outside and writes its 500 only after the panic has
		// unwound past here, so the 5xx series would miss exactly the failures
		// it exists to count; swallowing it turns a crash into an empty 200.
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
// CONTRACT: INFO for every status, 4xx and 5xx included. The status code already
// carries the outcome, and raising severity makes an error rate from
// severity_text disagree with one from http_response_status_code.
//
// CONTRACT: SUCCEEDING health checks are the one exemption, scoped by status and
// not a route list. The probe runs forever and swamps the stream (measured 96%
// of lines); a FAILING probe carries the status and latency that explain why, so
// it is logged like any request. This never fails the request.
// See [[health-check-logging]]
func logRequest(c *gin.Context, log *slog.Logger, started time.Time, status int) {
	defer func() {
		if recovered := recover(); recovered != nil {
			logFailure(c, log, "request_log_failed", "log_raised", recovered)
		}
	}()

	// CONTRACT: Log FullPath(), the matched TEMPLATE, not the concrete URL —
	// the raw path makes every order id its own route and destroys the
	// cardinality that is the field's only reason to exist. It is empty when
	// nothing matched, so a router 404 falls back to the raw path.
	route := c.FullPath()
	if route == "" {
		route = c.Request.URL.Path
	}

	if route == healthRoute && status >= nethttp.StatusOK && status < nethttp.StatusMultipleChoices {
		return
	}

	// The cache result is read straight off the response writer. An absent
	// header means NO field: an uncached route, and every route while
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
