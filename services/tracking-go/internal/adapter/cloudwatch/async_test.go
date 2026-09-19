package cloudwatch_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/cloudwatch"
)

// stalledSink stands in for a CloudWatch call that never returns, which is
// what a saturated or unreachable Floci endpoint looks like from here.
type stalledSink struct {
	entered chan struct{}
	release chan struct{}

	mu       sync.Mutex
	received []asyncDatum
}

type asyncDatum struct {
	name  string
	value float64
	dims  [][2]string
	ctx   context.Context //nolint:containedctx // the test asserts on the context the flusher passed
}

func newStalledSink() *stalledSink {
	return &stalledSink{
		entered: make(chan struct{}, 1024),
		release: make(chan struct{}),
	}
}

func (b *stalledSink) Publish(ctx context.Context, name string, value float64, dims [][2]string) {
	b.mu.Lock()
	b.received = append(b.received, asyncDatum{name: name, value: value, dims: dims, ctx: ctx})
	b.mu.Unlock()

	select {
	case b.entered <- struct{}{}:
	default:
	}
	<-b.release
}

// asyncSink completes immediately and counts what arrived.
type asyncSink struct {
	mu       sync.Mutex
	received []asyncDatum
	done     chan struct{}
	want     int
}

func newAsyncSink(want int) *asyncSink {
	return &asyncSink{done: make(chan struct{}), want: want}
}

func (r *asyncSink) Publish(ctx context.Context, name string, value float64, dims [][2]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.received = append(r.received, asyncDatum{name: name, value: value, dims: dims, ctx: ctx})
	if r.want > 0 && len(r.received) == r.want {
		close(r.done)
	}
}

func (r *asyncSink) snapshot() []asyncDatum {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]asyncDatum(nil), r.received...)
}

// The whole point of the decorator: the caller hands the asyncDatum off and returns
// while the backend is still blocked on the previous one. Without the buffer
// this test hangs until the deadline instead of failing fast.
func TestPublishDoesNotBlockOnASlowBackend(t *testing.T) {
	backend := newStalledSink()
	defer close(backend.release)

	async := cloudwatch.NewAsyncPublisher(context.Background(), backend, cloudwatch.AsyncOptions{
		BufferSize:   16,
		FlushTimeout: 50 * time.Millisecond,
	})
	defer async.Close()

	// The flusher picks the first asyncDatum up and blocks inside the backend.
	async.Publish(context.Background(), "http_errors_total", 1,
		[][2]string{{"Service", "tracking"}, {"StatusClass", "4xx"}})
	<-backend.entered

	returned := make(chan struct{})
	go func() {
		defer close(returned)
		for range 8 {
			async.Publish(context.Background(), "cache_requests_total", 1,
				[][2]string{{"Service", "tracking"}, {"Result", "MISS"}})
		}
	}()

	select {
	case <-returned:
	case <-time.After(2 * time.Second):
		t.Fatal("Publish blocked while the backend was stalled; the request path pays the metrics latency")
	}
}

// An overflowing buffer DROPS. It must neither block the caller (that is the
// defect) nor grow without bound (that is an OOM under load).
func TestPublishDropsRatherThanBlockingWhenTheBufferIsFull(t *testing.T) {
	backend := newStalledSink()
	defer close(backend.release)

	const buffer = 4
	async := cloudwatch.NewAsyncPublisher(context.Background(), backend, cloudwatch.AsyncOptions{
		BufferSize:   buffer,
		FlushTimeout: 50 * time.Millisecond,
	})
	defer async.Close()

	async.Publish(context.Background(), "http_errors_total", 1, nil)
	<-backend.entered

	// Far more than the buffer can hold, with the only consumer stalled.
	const offered = buffer + 500
	returned := make(chan struct{})
	go func() {
		defer close(returned)
		for range offered {
			async.Publish(context.Background(), "cache_requests_total", 1, nil)
		}
	}()

	select {
	case <-returned:
	case <-time.After(2 * time.Second):
		t.Fatal("Publish blocked when the buffer was full; it must drop instead")
	}

	// Nothing unbounded accumulated: the buffer holds at most BufferSize, so the
	// overwhelming majority of the offered data was dropped rather than queued.
	if dropped := async.Dropped(); dropped < offered-buffer {
		t.Errorf("Dropped() = %d, want at least %d — the buffer grew past its bound instead of dropping",
			dropped, offered-buffer)
	}
	if queued := async.Buffered(); queued > buffer {
		t.Errorf("Buffered() = %d, want at most %d — the buffer is not bounded", queued, buffer)
	}
}

// A drop must not itself become a hot-path cost: the count is aggregated and
// reported periodically, never one log line per dropped asyncDatum.
func TestDropsAreCountedNotLoggedPerDatum(t *testing.T) {
	backend := newStalledSink()
	defer close(backend.release)

	async := cloudwatch.NewAsyncPublisher(context.Background(), backend, cloudwatch.AsyncOptions{
		BufferSize:   1,
		FlushTimeout: 50 * time.Millisecond,
	})
	defer async.Close()

	async.Publish(context.Background(), "http_errors_total", 1, nil)
	<-backend.entered

	for range 50 {
		async.Publish(context.Background(), "cache_requests_total", 1, nil)
	}

	// TakeDropped resets, so the periodic report describes ONE window rather
	// than a cumulative total that re-reports the same drops forever.
	first := async.TakeDropped()
	if first == 0 {
		t.Fatal("no drops were counted")
	}
	if second := async.TakeDropped(); second != 0 {
		t.Errorf("TakeDropped() = %d on the second call, want 0 — the window did not reset", second)
	}
}

// Every asyncDatum buffered when Close is called still reaches the backend. Nothing
// else in the suite exercises the drain, which is what makes it easy to leave
// broken.
func TestCloseDrainsTheBuffer(t *testing.T) {
	const count = 32
	backend := newAsyncSink(count)
	async := cloudwatch.NewAsyncPublisher(context.Background(), backend, cloudwatch.AsyncOptions{
		BufferSize: 64,
	})

	for i := range count {
		async.Publish(context.Background(), "cache_requests_total", float64(i), nil)
	}

	async.Close()

	got := backend.snapshot()
	if len(got) != count {
		t.Fatalf("the backend received %d data, want %d — Close dropped buffered metrics", len(got), count)
	}
	for i, d := range got {
		if d.value != float64(i) {
			t.Errorf("asyncDatum %d value = %v, want %v — the drain reordered or lost data", i, d.value, float64(i))
		}
	}
}

// The drain is BOUNDED: an unreachable backend must not hang the process at
// shutdown. The flush window expires and Close returns.
func TestCloseReturnsWhenTheBackendNeverResponds(t *testing.T) {
	backend := newStalledSink()
	defer close(backend.release)

	async := cloudwatch.NewAsyncPublisher(context.Background(), backend, cloudwatch.AsyncOptions{
		BufferSize:     64,
		FlushTimeout:   150 * time.Millisecond,
		ReportInterval: time.Hour,
	})

	for range 10 {
		async.Publish(context.Background(), "cache_requests_total", 1, nil)
	}
	<-backend.entered

	closed := make(chan struct{})
	go func() {
		defer close(closed)
		async.Close()
	}()

	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("Close hung on an unreachable backend; the process cannot exit")
	}
}

// Close is idempotent: the composition root joins it from more than one
// shutdown branch, exactly as it joins the ticker and the outbox poller.
func TestCloseIsIdempotent(t *testing.T) {
	backend := newAsyncSink(0)
	async := cloudwatch.NewAsyncPublisher(context.Background(), backend, cloudwatch.AsyncOptions{})

	async.Close()
	async.Close()
}

// THE context trap. The asyncDatum is sent from a goroutine that outlives the
// request, so the context it carries must NOT be the request's — that one is
// cancelled the instant the response is written, and the publish then fails
// with `context canceled` having never reached the backend.
func TestTheBackgroundSendDoesNotInheritRequestCancellation(t *testing.T) {
	backend := newAsyncSink(1)
	async := cloudwatch.NewAsyncPublisher(context.Background(), backend, cloudwatch.AsyncOptions{
		BufferSize: 8,
	})
	defer async.Close()

	type key struct{}
	requestCtx, cancelRequest := context.WithCancel(context.WithValue(context.Background(), key{}, "trace"))

	async.Publish(requestCtx, "http_errors_total", 1, nil)
	// The response is written and net/http cancels the request context.
	cancelRequest()

	select {
	case <-backend.done:
	case <-time.After(2 * time.Second):
		t.Fatal("the asyncDatum never reached the backend")
	}

	got := backend.snapshot()
	if err := got[0].ctx.Err(); err != nil {
		t.Errorf("the background send carried a cancelled context (%v); it inherited the request's cancellation", err)
	}
	// Values must survive: the span context rides on the context, and losing it
	// detaches the publish span from the trace that caused it.
	if v := got[0].ctx.Value(key{}); v != "trace" {
		t.Errorf("context values were lost (%v); the publish span cannot join its request's trace", v)
	}
}

// The asyncDatum itself is copied at hand-off. A caller reusing its dimensions slice
// must not be able to mutate what the flusher has not sent yet.
func TestTheDimensionsAreCopiedAtHandOff(t *testing.T) {
	backend := newAsyncSink(1)
	async := cloudwatch.NewAsyncPublisher(context.Background(), backend, cloudwatch.AsyncOptions{
		BufferSize: 8,
	})
	defer async.Close()

	dims := [][2]string{{"Service", "tracking"}, {"Result", "HIT"}}
	async.Publish(context.Background(), "cache_requests_total", 1, dims)
	dims[1] = [2]string{"Result", "MUTATED"}

	select {
	case <-backend.done:
	case <-time.After(2 * time.Second):
		t.Fatal("the asyncDatum never reached the backend")
	}

	got := backend.snapshot()[0]
	if got.dims[1][1] != "HIT" {
		t.Errorf("dimension value = %q, want HIT — the caller's slice was not copied", got.dims[1][1])
	}
}

// The decorator changes WHEN and HOW a asyncDatum is sent, never WHAT is measured.
func TestEveryFieldReachesTheBackendUnchanged(t *testing.T) {
	backend := newAsyncSink(1)
	async := cloudwatch.NewAsyncPublisher(context.Background(), backend, cloudwatch.AsyncOptions{
		BufferSize: 8,
	})
	defer async.Close()

	async.Publish(context.Background(), cloudwatch.MetricCacheOperationDuration, 12.5,
		[][2]string{{"Service", "tracking"}, {"Operation", "get"}})

	select {
	case <-backend.done:
	case <-time.After(2 * time.Second):
		t.Fatal("the asyncDatum never reached the backend")
	}

	got := backend.snapshot()[0]
	if got.name != cloudwatch.MetricCacheOperationDuration {
		t.Errorf("name = %q", got.name)
	}
	if got.value != 12.5 {
		t.Errorf("value = %v, want 12.5", got.value)
	}
	if len(got.dims) != 2 || got.dims[0][0] != "Service" || got.dims[1][1] != "get" {
		t.Errorf("dimensions = %v", got.dims)
	}
}
