package main

import (
	"context"
	"errors"
	"net"
	nethttp "net/http"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The composition root's process-level tests.
//
// They are in `package main` because that is the only way to reach run(): the
// route table is covered where it can be imported (adapterhttp.NewAppRouter), and
// what is left here is exactly the part that needs a real process — the config
// gate, a listening socket, and the shutdown path.

// minimalEnv sets ONLY what is required, plus the flags that keep the process off
// the network it does not need for this assertion.
//
// The four required variables and nothing else optional, so this doubles as a
// check that the defaults really are defaults: any variable that has silently
// become required would fail these tests.
func minimalEnv(t *testing.T, port int) {
	t.Helper()

	// The exactly-four required ones.
	t.Setenv("DATABASE_WRITER_URL", "mysql+pymysql://test:test@127.0.0.1:7002/tracking")
	t.Setenv("DATABASE_READER_URL", "mysql+pymysql://test:test@127.0.0.1:7002/tracking")
	t.Setenv("GRPC_API_KEY", "internal-key")
	t.Setenv("TRACKING_CARRIER_API_KEY", "carrier-key")

	t.Setenv("PORT", strconv.Itoa(port))

	// CACHE off, so no Redis client is constructed and none needs to be
	// reachable. METRICS off, so no CloudWatch publisher is built and no ticker
	// goroutine starts querying a database this test never populates. Both are
	// composition-root decisions, which is precisely why they can be made from
	// out here.
	t.Setenv("CACHE_ENABLED", "false")
	t.Setenv("METRICS_ENABLED", "false")

	// No queue: the publisher becomes the noop rather than trying to send to "".
	t.Setenv("EVENTS_QUEUE_URL", "")

	// Keep the OTLP exporter from retrying against a collector that is not here.
	// Config lives in ENV VARS, never in code — including in a test.
	t.Setenv("OTEL_TRACES_EXPORTER", "none")
	t.Setenv("OTEL_METRICS_EXPORTER", "none")
	t.Setenv("OTEL_LOGS_EXPORTER", "none")
	t.Setenv("OTEL_SDK_DISABLED", "true")
}

// TestRunFailsLoudlyOnAMissingRequiredVariable is the config gate.
//
// A misconfigured process must REFUSE TO START rather than boot and fail later at
// its first query — which would present as a working service that 500s, on a task
// the orchestrator considers healthy.
func TestRunFailsLoudlyOnAMissingRequiredVariable(t *testing.T) {
	for _, missing := range []string{
		"DATABASE_WRITER_URL",
		"DATABASE_READER_URL",
		"GRPC_API_KEY",
		"TRACKING_CARRIER_API_KEY",
	} {
		t.Run("without "+missing, func(t *testing.T) {
			minimalEnv(t, freePort(t))
			t.Setenv(missing, "")

			err := run()
			if err == nil {
				t.Fatalf("run() returned nil with %s unset; the process would boot misconfigured", missing)
			}
			if !strings.Contains(err.Error(), missing) {
				t.Fatalf("err = %v, want it to NAME the missing variable %s — an error that "+
					"does not say which one leaves the operator guessing", err, missing)
			}
		})
	}
}

// TestRunServesHealthAndShutsDownGracefully is the end-to-end proof that the
// wiring produces a SERVING process.
//
// It starts run() for real, hits /v1/health over a socket, then sends the process
// the same SIGTERM ECS sends when it drains a task and requires run() to return
// cleanly. Everything in between — config, both pools, the null gateway, the noop
// publisher, the router — had to be constructed for this to pass.
func TestRunServesHealthAndShutsDownGracefully(t *testing.T) {
	port := freePort(t)
	minimalEnv(t, port)

	done := make(chan error, 1)
	go func() { done <- run() }()

	// The health probe deliberately touches NO database, so it answers as soon as
	// the listener is up — with no MySQL reachable anywhere in this test.
	body, err := waitForHealth(t, port)
	if err != nil {
		t.Fatalf("GET /v1/health: %v", err)
	}
	if !strings.Contains(body, `"status":"ok"`) {
		t.Fatalf("body = %s, want it to carry \"status\":\"ok\"", body)
	}

	// The real signal, not a context cancel: signal.NotifyContext is the thing
	// under test, and cancelling a context by hand would not exercise it.
	if err := syscall.Kill(syscall.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatalf("sending SIGTERM: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run() returned %v on SIGTERM, want a clean shutdown", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("run() did not return within 30s of SIGTERM; the graceful shutdown path is stuck")
	}
}

// waitForHealth polls until the listener accepts, so the test does not race the
// goroutine that starts it.
func waitForHealth(t *testing.T, port int) (string, error) {
	t.Helper()

	url := "http://127.0.0.1:" + strconv.Itoa(port) + "/v1/health"
	deadline := time.Now().Add(15 * time.Second)

	var lastErr error
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		// NewRequestWithContext, never http.Get: noctx rejects a request that
		// cannot be cancelled, and a hung probe here would burn the whole timeout.
		req, err := nethttp.NewRequestWithContext(ctx, nethttp.MethodGet, url, nil)
		if err != nil {
			cancel()
			return "", err
		}
		resp, err := nethttp.DefaultClient.Do(req)
		if err != nil {
			cancel()
			lastErr = err
			time.Sleep(50 * time.Millisecond)
			continue
		}

		buf := make([]byte, 256)
		n, _ := resp.Body.Read(buf)
		_ = resp.Body.Close()
		cancel()

		if resp.StatusCode != nethttp.StatusOK {
			return "", errors.New("status " + resp.Status)
		}
		return string(buf[:n]), nil
	}
	return "", lastErr
}

// freePort asks the kernel for an unused port.
//
// A hardcoded one would make these two tests flaky against anything already bound
// — including the service itself running locally, which is the likeliest case.
func freePort(t *testing.T) int {
	t.Helper()

	// (*net.ListenConfig).Listen, not net.Listen: the noctx linter rejects the
	// latter because a listener that takes no context cannot be cancelled.
	var config net.ListenConfig
	listener, err := config.Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserving a port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatalf("closing the probe listener: %v", err)
	}
	return port
}
