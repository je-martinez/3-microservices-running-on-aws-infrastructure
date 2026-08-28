package logging_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// These tests exercise the PATH THE PROCESS ACTUALLY TAKES, not the pieces it is
// built from.
//
// context_test.go already proves ContextHandler enriches a record, by wrapping
// it by hand. That test passed for the entire time the running service emitted
// not one line carrying request_id, cognito_sub or user_id: logging.New built the
// base handler and wrapped nothing, so the wrapper the tests exercised was the
// only place it existed. Assembling the collaborators inside the test asserts
// that the parts fit together — never that anything assembled them.
//
// So the subject here is deliberately the CONSTRUCTOR the composition root calls
// (logging.New, and Install on top of it), with nothing wrapped by the test.

// TestNewEnrichesFromTheAmbientLogContext is the regression test for that gap.
func TestNewEnrichesFromTheAmbientLogContext(t *testing.T) {
	var buf bytes.Buffer

	// NOTHING is wrapped here. If New stops wrapping ContextHandler, this fails.
	log := logging.New(&buf, "tracking", "local")

	ctx := logging.WithLogFields(context.Background(),
		slog.String(logging.KeyRequestID, "req_7gK3mP1vXz9wLq2bN8rRt4Yc"),
		// Two DIFFERENT values: a sub is not a usr_ id, and a test reusing one
		// string for both cannot fail when the two are confused.
		slog.String(logging.KeyCognitoSub, "sub-abc-123"),
		slog.String(logging.KeyUserID, "usr_9f2c"),
		slog.String(logging.KeyOrderID, "ord_77"),
		slog.String(logging.KeyTrackingID, "trk_88"),
		slog.String(logging.KeyEmailHash, "9a1f0c"),
		slog.String(logging.KeyCacheResult, "hit"),
	)
	log.InfoContext(ctx, "tracking created")

	got := decode(t, &buf)
	want := map[string]string{
		logging.KeyRequestID:   "req_7gK3mP1vXz9wLq2bN8rRt4Yc",
		logging.KeyCognitoSub:  "sub-abc-123",
		logging.KeyUserID:      "usr_9f2c",
		logging.KeyOrderID:     "ord_77",
		logging.KeyTrackingID:  "trk_88",
		logging.KeyEmailHash:   "9a1f0c",
		logging.KeyCacheResult: "hit",
	}
	for key, value := range want {
		if got[key] != value {
			t.Errorf("%s = %v, want %q — the default logging path drops the ambient "+
				"log context, so no line the service emits can be correlated", key, got[key], value)
		}
	}
}

// TestNewEnrichesTheDEFAULTLogger covers the reach of the enrichment.
//
// The composition root points slog.Default at a logger built on top of New, so a
// package that reaches for slog.InfoContext with no logger of its own is
// enriched too. That is the whole reason the enrichment wraps the HANDLER rather
// than a logger, and it is what the Python gets by attaching its filters to the
// root HANDLER (src/shared/logging/config.py) instead of to individual loggers.
//
// The full process logger (New + the trace layer) is assembled and asserted in
// cmd/server; this covers the half that this package owns.
func TestNewEnrichesTheDefaultLogger(t *testing.T) {
	restore := slog.Default()
	t.Cleanup(func() { slog.SetDefault(restore) })

	var buf bytes.Buffer
	slog.SetDefault(logging.New(&buf, logging.ServiceName, "local"))

	ctx := logging.WithLogFields(context.Background(),
		slog.String(logging.KeyRequestID, "req_7gK3mP1vXz9wLq2bN8rRt4Yc"),
		slog.String(logging.KeyCognitoSub, "sub-xyz-456"),
	)
	// No logger threaded through: the ambient default, exactly as a library or a
	// deep call site would use it.
	slog.InfoContext(ctx, "from the default logger")

	got := decode(t, &buf)
	if got[logging.KeyRequestID] != "req_7gK3mP1vXz9wLq2bN8rRt4Yc" {
		t.Errorf("request_id = %v, want it present on a line from the DEFAULT logger", got[logging.KeyRequestID])
	}
	if got[logging.KeyCognitoSub] != "sub-xyz-456" {
		t.Errorf("cognito_sub = %v, want it present on a line from the DEFAULT logger", got[logging.KeyCognitoSub])
	}
}

// TestNewOmitsContextFieldsOutsideARequest keeps the enrichment from becoming a
// source of nulls.
//
// Startup lines, the metrics ticker and background work carry no log context.
// Omitted, never null: an emitted "user_id": null reads as a resolved identity
// that happened to be empty, rather than "not known at this point".
func TestNewOmitsContextFieldsOutsideARequest(t *testing.T) {
	var buf bytes.Buffer
	logging.New(&buf, "tracking", "local").Info("http server starting")

	line := strings.TrimSpace(buf.String())
	var got map[string]any
	if err := json.Unmarshal([]byte(line), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	for _, key := range []string{
		logging.KeyRequestID, logging.KeyCognitoSub, logging.KeyUserID,
		logging.KeyOrderID, logging.KeyTrackingID, logging.KeyEmailHash,
		logging.KeyCacheResult,
	} {
		if _, present := got[key]; present {
			t.Errorf("%s is present as %v on a line logged outside any request; "+
				"it must be OMITTED, never zeroed", key, got[key])
		}
	}
}

// TestNewKeepsCallSiteAttributesWinning pins the precedence THROUGH the
// production constructor.
//
// ContextHandler's own test asserts this against a hand-wrapped handler; if the
// production path ever wrapped in the other order (context fields added BEFORE
// the record's own), our JSON handler keeps the first occurrence and the ambient
// value would silently win — making a line about one order claim another's id.
func TestNewKeepsCallSiteAttributesWinning(t *testing.T) {
	var buf bytes.Buffer
	log := logging.New(&buf, "tracking", "local")

	ctx := logging.WithLogFields(context.Background(),
		slog.String(logging.KeyOrderID, "ord_ambient"))
	log.InfoContext(ctx, "m", slog.String(logging.KeyOrderID, "ord_explicit"))

	got := decode(t, &buf)
	if got[logging.KeyOrderID] != "ord_explicit" {
		t.Errorf("order_id = %v, want ord_explicit — the call site is being specific "+
			"on purpose and must beat the ambient value", got[logging.KeyOrderID])
	}
}
