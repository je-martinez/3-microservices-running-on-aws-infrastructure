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

func contextLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(logging.NewContextHandler(
		logging.NewHandler(buf, "tracking", "local", slog.LevelDebug)))
}

func TestWithLogFieldsEmitsTheAmbientContext(t *testing.T) {
	var buf bytes.Buffer
	log := contextLogger(&buf)

	ctx := logging.WithLogFields(context.Background(),
		slog.String("cognito_sub", "sub-abc"),
		slog.String("request_id", "req_7gK3mP1vXz9wLq2bN8rRt4Yc"),
	)
	log.InfoContext(ctx, "m")

	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if got["cognito_sub"] != "sub-abc" {
		t.Errorf("cognito_sub = %v, want sub-abc", got["cognito_sub"])
	}
	if got["request_id"] != "req_7gK3mP1vXz9wLq2bN8rRt4Yc" {
		t.Errorf("request_id = %v", got["request_id"])
	}
}

// Exactly seven keys, and no others. A typo'd key must not become a field.
func TestOnlyTheSevenAllowedKeysSurvive(t *testing.T) {
	var buf bytes.Buffer
	log := contextLogger(&buf)

	ctx := logging.WithLogFields(context.Background(),
		slog.String("cognito_sub", "s"),
		slog.String("user_id", "usr_1"),
		slog.String("order_id", "ord_1"),
		slog.String("tracking_id", "trk_1"),
		slog.String("email_hash", "abcdef0123456789"),
		slog.String("request_id", "req_7gK3mP1vXz9wLq2bN8rRt4Yc"),
		slog.String("cache_result", "hit"),
		// Not on the list: dropped.
		slog.String("congito_sub", "typo"),
		slog.String("shipping_address", "1 Main St"),
		slog.String("email", "a@b.com"),
	)
	log.InfoContext(ctx, "m")

	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	for _, key := range []string{
		"cognito_sub", "user_id", "order_id", "tracking_id",
		"email_hash", "request_id", "cache_result",
	} {
		if _, present := got[key]; !present {
			t.Errorf("allowed key %s was dropped", key)
		}
	}
	for _, key := range []string{"congito_sub", "shipping_address", "email"} {
		if _, present := got[key]; present {
			t.Errorf("key %s is not on the allowed list but was emitted", key)
		}
	}
}

// Both nil and "" are dropped at merge time.
func TestEmptyContextValuesAreDropped(t *testing.T) {
	var buf bytes.Buffer
	log := contextLogger(&buf)

	ctx := logging.WithLogFields(context.Background(),
		slog.String("user_id", ""),
		slog.Any("order_id", nil),
		slog.String("tracking_id", "trk_1"),
	)
	log.InfoContext(ctx, "m")

	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if _, present := got["user_id"]; present {
		t.Error("empty user_id must be dropped")
	}
	if _, present := got["order_id"]; present {
		t.Error("nil order_id must be dropped")
	}
	if got["tracking_id"] != "trk_1" {
		t.Error("tracking_id was lost")
	}
}

// Merging returns a NEW context; the parent is unchanged.
func TestWithLogFieldsMergesWithoutMutatingTheParent(t *testing.T) {
	parent := logging.WithLogFields(context.Background(), slog.String("cognito_sub", "s"))
	child := logging.WithLogFields(parent, slog.String("user_id", "usr_1"))

	if len(logging.LogFields(parent)) != 1 {
		t.Errorf("parent gained a field: %v", logging.LogFields(parent))
	}
	if len(logging.LogFields(child)) != 2 {
		t.Errorf("child = %v, want both fields", logging.LogFields(child))
	}
}

// Later merges override earlier ones for the same key — that is how the
// late-resolved usr_ id reaches every line after the gRPC call.
func TestLaterMergeOverridesEarlier(t *testing.T) {
	ctx := logging.WithLogFields(context.Background(), slog.String("user_id", "usr_old"))
	ctx = logging.WithLogFields(ctx, slog.String("user_id", "usr_new"))

	for _, a := range logging.LogFields(ctx) {
		if a.Key == "user_id" && a.Value.String() != "usr_new" {
			t.Errorf("user_id = %q, want usr_new", a.Value.String())
		}
	}
}

// An explicit field at the CALL SITE wins over the ambient context: a handler
// logging about a different order is being specific on purpose.
func TestCallSiteAttributeWinsOverContext(t *testing.T) {
	var buf bytes.Buffer
	log := contextLogger(&buf)

	ctx := logging.WithLogFields(context.Background(), slog.String("order_id", "ord_ambient"))
	log.InfoContext(ctx, "m", slog.String("order_id", "ord_explicit"))

	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if got["order_id"] != "ord_explicit" {
		t.Errorf("order_id = %v, want the call-site value ord_explicit", got["order_id"])
	}
}

func TestNoContextFieldsIsNotAnError(t *testing.T) {
	var buf bytes.Buffer
	contextLogger(&buf).InfoContext(context.Background(), "m")

	var got map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(buf.String())), &got); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if got["message"] != "m" {
		t.Errorf("message = %v", got["message"])
	}
}
