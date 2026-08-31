package cloudwatch_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	awscw "github.com/aws/aws-sdk-go-v2/service/cloudwatch"
	cwtypes "github.com/aws/aws-sdk-go-v2/service/cloudwatch/types"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
)

// fakeCW records every PutMetricData call and can be made to fail.
type fakeCW struct {
	mu    sync.Mutex
	calls []*awscw.PutMetricDataInput
	err   error
}

func (f *fakeCW) PutMetricData(_ context.Context, in *awscw.PutMetricDataInput, _ ...func(*awscw.Options)) (*awscw.PutMetricDataOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, in)
	if f.err != nil {
		return nil, f.err
	}
	return &awscw.PutMetricDataOutput{}, nil
}

func (f *fakeCW) snapshot() []*awscw.PutMetricDataInput {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*awscw.PutMetricDataInput(nil), f.calls...)
}

func TestPublishShape(t *testing.T) {
	client := &fakeCW{}
	p := cloudwatch.NewPublisher(client)

	p.Publish(context.Background(), "orders_by_tracking_status_total", 7,
		[][2]string{{"Service", "tracking"}, {"Status", "DELIVERED"}})

	calls := client.snapshot()
	if len(calls) != 1 {
		t.Fatalf("got %d PutMetricData calls, want 1", len(calls))
	}
	in := calls[0]
	if *in.Namespace != "3MRAI" {
		t.Errorf("Namespace = %q, want 3MRAI (one namespace across all four services)", *in.Namespace)
	}
	// One datum per call.
	if len(in.MetricData) != 1 {
		t.Fatalf("got %d data in one call, want exactly 1", len(in.MetricData))
	}
	d := in.MetricData[0]
	if *d.MetricName != "orders_by_tracking_status_total" {
		t.Errorf("MetricName = %q", *d.MetricName)
	}
	if *d.Value != 7 {
		t.Errorf("Value = %v, want 7", *d.Value)
	}
	if d.Unit != cwtypes.StandardUnitCount {
		t.Errorf("Unit = %v, want Count", d.Unit)
	}
	// The dimension SET is a contract: Floci does not aggregate across
	// dimensions, so a query naming a different set returns an empty result.
	if len(d.Dimensions) != 2 {
		t.Fatalf("got %d dimensions, want 2", len(d.Dimensions))
	}
	if *d.Dimensions[0].Name != "Service" || *d.Dimensions[0].Value != "tracking" {
		t.Errorf("dimension 0 = %s=%s", *d.Dimensions[0].Name, *d.Dimensions[0].Value)
	}
	if *d.Dimensions[1].Name != "Status" || *d.Dimensions[1].Value != "DELIVERED" {
		t.Errorf("dimension 1 = %s=%s", *d.Dimensions[1].Name, *d.Dimensions[1].Value)
	}
}

// A zero is published as given: a series that stops being published reads as
// "no data" in a dashboard, not as zero.
func TestPublishDoesNotShortCircuitOnZero(t *testing.T) {
	client := &fakeCW{}
	cloudwatch.NewPublisher(client).Publish(context.Background(),
		"http_errors_total", 0, [][2]string{{"Service", "tracking"}, {"StatusClass", "5xx"}})

	calls := client.snapshot()
	if len(calls) != 1 {
		t.Fatalf("a zero value was not published; got %d calls", len(calls))
	}
	if *calls[0].MetricData[0].Value != 0 {
		t.Errorf("Value = %v, want 0", *calls[0].MetricData[0].Value)
	}
}

// Publish NEVER returns an error to callers — a metrics backend being
// unreachable may not break the request or the loop that produced the metric.
func TestPublishSwallowsFailures(t *testing.T) {
	client := &fakeCW{err: errors.New("cloudwatch is down")}
	p := cloudwatch.NewPublisher(client)

	// Compiles only if Publish returns nothing, and must not panic.
	p.Publish(context.Background(), "http_errors_total", 1,
		[][2]string{{"Service", "tracking"}, {"StatusClass", "4xx"}})
}

func TestNoopPublisherMakesNoCalls(t *testing.T) {
	// Nothing to assert against a client — the point is that it needs none and
	// never panics. Used by suites that must not reach AWS.
	cloudwatch.NewNoopPublisher().Publish(context.Background(), "m", 1, nil)
}

// Anything that is not DELIVERED counts as IN_PROGRESS, an unknown status
// included: a new status should land in "still in flight" by default rather
// than disappear from both series.
func TestSplitStatusCounts(t *testing.T) {
	tests := []struct {
		name           string
		raw            map[string]int64
		wantDelivered  int64
		wantInProgress int64
	}{
		{"empty table", map[string]int64{}, 0, 0},
		{"only delivered", map[string]int64{"DELIVERED": 4}, 4, 0},
		{"mixed", map[string]int64{"DELIVERED": 4, "PLACED": 2, "IN_TRANSIT": 3}, 4, 5},
		{"unknown status counts as in progress", map[string]int64{"WAREHOUSED": 6}, 0, 6},
		{"nil map", nil, 0, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			delivered, inProgress := cloudwatch.SplitStatusCounts(tt.raw)
			if delivered != tt.wantDelivered || inProgress != tt.wantInProgress {
				t.Errorf("SplitStatusCounts(%v) = (%d, %d), want (%d, %d)",
					tt.raw, delivered, inProgress, tt.wantDelivered, tt.wantInProgress)
			}
		})
	}
}
