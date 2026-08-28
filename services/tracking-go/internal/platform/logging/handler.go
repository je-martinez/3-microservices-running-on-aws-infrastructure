// Package logging renders every log line as one JSON object with a field schema
// shared across all four 3MRAI services, so a single dashboard query spans them.
//
// slog.JSONHandler cannot produce this shape: it emits time/level/msg under
// fixed names and renders zero values rather than dropping them. The rules that
// forced a hand-written handler:
//
//   - severity_text is the OTel name (WARN, FATAL), never Go's or Python's
//     (WARNING, CRITICAL). Both spellings reaching the backend at once made
//     every dashboard filter silently return half the matches.
//   - nil and empty-string values are DROPPED, never emitted as null or "". An
//     emitted null reads as "resolved, and it was null" rather than "not known
//     at this point in the request".
//   - a value JSON cannot encode is STRINGIFIED, never dropped: losing a field
//     silently is how a diagnostic disappears exactly when it is needed.
package logging

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"time"
)

// LevelFatal is one step above slog.LevelError, mapping to OTel's FATAL/21.
// slog has no fatal level of its own.
const LevelFatal = slog.Level(12)

// OTel severity numbers from the logs data model. Explicit rather than derived
// from the level's integer value, so the mapping is auditable against the spec.
var severityNumbers = map[slog.Level]int{
	slog.LevelDebug: 5,
	slog.LevelInfo:  9,
	slog.LevelWarn:  13,
	slog.LevelError: 17,
	LevelFatal:      21,
}

var severityTexts = map[slog.Level]string{
	slog.LevelDebug: "DEBUG",
	slog.LevelInfo:  "INFO",
	slog.LevelWarn:  "WARN",
	slog.LevelError: "ERROR",
	LevelFatal:      "FATAL",
}

// timestampLayout is UTC ISO-8601 at MILLISECOND precision; the handler appends
// the literal Z. RFC3339Nano is wrong here twice over: variable precision, and
// a +00:00 offset where the other services emit Z.
const timestampLayout = "2006-01-02T15:04:05.000"

// Handler renders records as single-line JSON.
type Handler struct {
	mu                    *sync.Mutex
	w                     io.Writer
	level                 slog.Leveler
	serviceName           string
	deploymentEnvironment string
	// attrs accumulated by WithAttrs, already flattened to key/value pairs.
	attrs []slog.Attr
	// groups accumulated by WithGroup; joined with "." into the emitted key.
	groups []string
}

// NewHandler builds a handler writing to w.
func NewHandler(w io.Writer, serviceName, deploymentEnvironment string, level slog.Leveler) slog.Handler {
	if level == nil {
		level = slog.LevelInfo
	}
	return &Handler{
		mu:                    &sync.Mutex{},
		w:                     w,
		level:                 level,
		serviceName:           serviceName,
		deploymentEnvironment: deploymentEnvironment,
	}
}

// New builds a *slog.Logger at INFO over NewHandler, ALREADY WRAPPED in
// NewContextHandler.
//
// The enrichment belongs in the DEFAULT constructor, not in an opt-in one beside
// it, because the failure mode is SILENCE. A logger built without the wrapper
// emits perfectly valid JSON that simply carries no request_id, cognito_sub or
// order_id — nothing errors, no test that does not look for those fields fails,
// and the loss shows up only as an empty dashboard weeks later. That is exactly
// how this service ran with the wrapper defined, tested, and used nowhere: New
// built the base handler and wrapped nothing.
//
// The base handler stays reachable as NewHandler for the tests that assert the
// RENDERING rules in isolation; every path that builds a logger for the service
// goes through here or through Install.
//
// It does NOT wrap the trace handler: that one lives in internal/adapter/otel
// and this package must not import it (a platform package depending on the OTel
// SDK would make every consumer of the log schema depend on it too). The
// composition root applies it on the outside — see cmd/server/main.go.
func New(w io.Writer, serviceName, deploymentEnvironment string) *slog.Logger {
	return slog.New(NewContextHandler(
		NewHandler(w, serviceName, deploymentEnvironment, slog.LevelInfo)))
}

func (h *Handler) Enabled(_ context.Context, level slog.Level) bool {
	return level >= h.level.Level()
}

func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	clone := *h
	clone.attrs = make([]slog.Attr, 0, len(h.attrs)+len(attrs))
	clone.attrs = append(clone.attrs, h.attrs...)
	for _, a := range attrs {
		clone.attrs = append(clone.attrs, qualify(h.groups, a))
	}
	return &clone
}

func (h *Handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	clone := *h
	clone.groups = append(append([]string{}, h.groups...), name)
	return &clone
}

// Handle writes one JSON object. The base fields come first, in a fixed order,
// then everything the call site (and WithAttrs) contributed.
func (h *Handler) Handle(_ context.Context, r slog.Record) error {
	// A hand-built buffer rather than a map: encoding/json sorts map keys, and
	// the base-field ORDER is part of the shape the other services emit.
	buf := make([]byte, 0, 512)
	buf = append(buf, '{')

	buf = appendString(buf, "severity_text", severityText(r.Level))
	buf = append(buf, ',')
	buf = append(buf, `"severity_number":`...)
	buf = strconv.AppendInt(buf, int64(severityNumbers[r.Level]), 10)

	when := r.Time
	if when.IsZero() {
		when = time.Now()
	}
	buf = append(buf, ',')
	buf = appendString(buf, "timestamp", when.UTC().Format(timestampLayout)+"Z")
	buf = append(buf, ',')
	buf = appendString(buf, "service_name", h.serviceName)
	buf = append(buf, ',')
	buf = appendString(buf, "deployment_environment", h.deploymentEnvironment)
	buf = append(buf, ',')
	buf = appendString(buf, "message", r.Message)

	seen := map[string]bool{
		"severity_text": true, "severity_number": true, "timestamp": true,
		"service_name": true, "deployment_environment": true, "message": true,
	}

	for _, a := range h.attrs {
		buf = h.appendAttr(buf, a, seen)
	}
	r.Attrs(func(a slog.Attr) bool {
		buf = h.appendAttr(buf, qualify(h.groups, a), seen)
		return true
	})

	buf = append(buf, '}', '\n')

	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := h.w.Write(buf)
	return err
}

// appendAttr writes one field, applying the two rules that make this handler
// exist: drop nil and empty strings, stringify anything JSON cannot encode.
func (h *Handler) appendAttr(buf []byte, a slog.Attr, seen map[string]bool) []byte {
	a.Value = a.Value.Resolve()
	if a.Key == "" || seen[a.Key] {
		return buf
	}

	// A group flattens into dotted keys rather than a nested object: the schema
	// downstream is flat, and a nested object would not be queryable as a field.
	if a.Value.Kind() == slog.KindGroup {
		for _, member := range a.Value.Group() {
			buf = h.appendAttr(buf, slog.Attr{Key: a.Key + "." + member.Key, Value: member.Value}, seen)
		}
		return buf
	}

	raw := a.Value.Any()
	// Omitted, never null; omitted, never "".
	if raw == nil {
		return buf
	}
	if a.Value.Kind() == slog.KindString && a.Value.String() == "" {
		return buf
	}

	encoded, err := json.Marshal(raw)
	if err != nil {
		// Stringified, never dropped.
		encoded, err = json.Marshal(fmt.Sprintf("%v", raw))
		if err != nil {
			return buf
		}
	}

	seen[a.Key] = true
	buf = append(buf, ',')
	buf = appendKey(buf, a.Key)
	return append(buf, encoded...)
}

func severityText(level slog.Level) string {
	if text, ok := severityTexts[level]; ok {
		return text
	}
	return level.String()
}

func qualify(groups []string, a slog.Attr) slog.Attr {
	for i := len(groups) - 1; i >= 0; i-- {
		a = slog.Attr{Key: groups[i] + "." + a.Key, Value: a.Value}
	}
	return a
}

func appendKey(buf []byte, key string) []byte {
	encoded, err := json.Marshal(key)
	if err != nil {
		return append(buf, `"?":`...)
	}
	buf = append(buf, encoded...)
	return append(buf, ':')
}

func appendString(buf []byte, key, value string) []byte {
	buf = appendKey(buf, key)
	encoded, err := json.Marshal(value)
	if err != nil {
		return append(buf, `""`...)
	}
	return append(buf, encoded...)
}
