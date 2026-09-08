// Package cloudwatch publishes this service's custom business metrics: this file
// turns a (name, value, dimensions) triple into one PutMetricData call, while
// scheduling and queries live in ticker.go.
//
// CONTRACT: Publish never returns an error — an unreachable metrics backend must
// not break the work it observes. Every failure is still an ERROR line carrying
// app_event=metric_publish_failed. See [[logging-context]]
//
// CONTRACT: One namespace, 3MRAI, and the DIMENSION SET is part of it. Floci
// does not aggregate across dimensions, so a GetMetricData query omitting one
// returns Values: [] with StatusCode "Complete" — a silent empty result, not an
// error. Dimensions are low-cardinality labels only, never a user id or email.
package cloudwatch

import (
	"context"
	"log/slog"

	"github.com/aws/aws-sdk-go-v2/aws"
	awscw "github.com/aws/aws-sdk-go-v2/service/cloudwatch"
	cwtypes "github.com/aws/aws-sdk-go-v2/service/cloudwatch/types"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	oteltrace "go.opentelemetry.io/otel/trace"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
)

// Namespace is the ONE namespace every 3MRAI metric is published under, across
// all four services. Never a per-service namespace.
const Namespace = "3MRAI"

// ServiceDimension is the Service dimension value every metric from THIS service
// carries.
const ServiceDimension = "tracking"

// Metric names. Shared with the collector's queries and with the dashboards.
const (
	MetricOrdersByStatus = "orders_by_tracking_status_total"
	MetricHTTPErrors     = "http_errors_total"
	MetricCacheRequests  = "cache_requests_total"
	// MetricCacheOperationDuration is emitted by the cache gateway (Group C),
	// which calls Publish with an Operation dimension. Its companion,
	// MetricCacheRequests, carries a KeyPrefix dimension that is ALWAYS the
	// first 3 colon-segments of the key and NEVER a full key: a full key embeds
	// identity, and dimension cardinality is billed.
	MetricCacheOperationDuration = "cache_operation_duration_ms"
)

// PutMetricDataAPI is the one CloudWatch call this package makes. Declared here,
// by the consumer, so the SDK client satisfies it without any wrapper.
type PutMetricDataAPI interface {
	PutMetricData(ctx context.Context, in *awscw.PutMetricDataInput, opts ...func(*awscw.Options)) (*awscw.PutMetricDataOutput, error)
}

// Publisher emits one metric datum. Publish NEVER returns an error — that is
// part of the contract, not an implementation detail, and every caller relies on
// it.
type Publisher interface {
	Publish(ctx context.Context, name string, value float64, dimensions [][2]string)
}

type publisher struct {
	client PutMetricDataAPI
	log    *slog.Logger
}

// NewPublisher builds a CloudWatch-backed publisher (Floci locally).
func NewPublisher(client PutMetricDataAPI) Publisher {
	return &publisher{client: client, log: slog.Default()}
}

// Publish emits one datum. Never returns an error — see the package docstring.
//
// value is published as given, 0 INCLUDED: a series that stops being published
// reads as "no data" in a dashboard, not as zero, so there is no falsy
// short-circuit here.
func (p *publisher) Publish(ctx context.Context, name string, value float64, dimensions [][2]string) {
	// A span NAMING THE METRIC. The metric name goes in the SPAN NAME, not only
	// an attribute: a waterfall renders names, and `PutMetricData` repeated N
	// times answers nothing.
	ctx, span := otelTracer().Start(ctx, "cloudwatch PutMetricData "+name,
		oteltrace.WithSpanKind(oteltrace.SpanKindClient),
		oteltrace.WithAttributes(
			attribute.String("rpc.system", "aws-api"),
			attribute.String("rpc.service", "CloudWatch"),
			attribute.String("rpc.method", "PutMetricData"),
			attribute.String("metric.name", name),
		),
	)
	defer span.End()

	dims := make([]cwtypes.Dimension, 0, len(dimensions))
	for _, d := range dimensions {
		dims = append(dims, cwtypes.Dimension{
			Name:  aws.String(d[0]),
			Value: aws.String(d[1]),
		})
	}

	_, err := p.client.PutMetricData(ctx, &awscw.PutMetricDataInput{
		Namespace: aws.String(Namespace),
		// ONE datum per call.
		MetricData: []cwtypes.MetricDatum{{
			MetricName: aws.String(name),
			Value:      aws.Float64(value),
			Unit:       cwtypes.StandardUnitCount,
			Dimensions: dims,
		}},
	})
	if err != nil {
		// The span records what happened to the CALL; Publish still returns
		// normally, because its contract is that it never fails a caller.
		span.SetStatus(codes.Error, "put_metric_data_failed")
		p.log.ErrorContext(ctx, "metric_publish_failed",
			slog.String("app_event", "metric_publish_failed"),
			slog.String("reason", "put_metric_data_failed"),
			slog.String("metric_name", name),
			slog.String("exception", err.Error()),
		)
		return
	}
	span.SetStatus(codes.Ok, "")
}

func otelTracer() oteltrace.Tracer { return tracing.Tracer(tracing.TracerMetrics) }

type noopPublisher struct{}

// NewNoopPublisher returns a publisher for suites (and runtimes) that must not
// reach CloudWatch.
func NewNoopPublisher() Publisher { return noopPublisher{} }

func (noopPublisher) Publish(context.Context, string, float64, [][2]string) {}
