package http_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// ─── fakes ──────────────────────────────────────────────────────────────────

type delFakeUserDeleter struct {
	count  int64
	err    error
	called bool
	sub    string
	userID string
}

func (f *delFakeUserDeleter) SoftDeleteByUser(
	_ context.Context, cognitoSub, userID string, _ audit.Actor, _ time.Time,
) (int64, error) {
	f.called = true
	f.sub, f.userID = cognitoSub, userID
	return f.count, f.err
}

type delFakeInvalidator struct {
	called bool
	sub    string
	userID string
}

func (f *delFakeInvalidator) InvalidateUser(_ context.Context, cognitoSub, userID string) {
	f.called = true
	f.sub, f.userID = cognitoSub, userID
}

type delFakeTagDeleter struct {
	count     int64
	err       error
	called    bool
	tag       string
	secondTag string
}

func (f *delFakeTagDeleter) SoftDeleteByTags(
	ctx context.Context, tag, secondTag string, actor audit.Actor, now time.Time,
) (int64, error) {
	f.secondTag = secondTag
	return f.SoftDeleteByTag(ctx, tag, actor, now)
}

func (f *delFakeTagDeleter) SoftDeleteByTag(
	_ context.Context, tag string, _ audit.Actor, _ time.Time,
) (int64, error) {
	f.called = true
	f.tag = tag
	return f.count, f.err
}

// delLogs captures the JSON log lines so a test can assert the *_failed line and
// its reason actually reached the stream.
type delLogs struct{ buf *bytes.Buffer }

func (l *delLogs) Has(key, want string) bool {
	for _, line := range strings.Split(l.buf.String(), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			continue
		}
		if got, ok := record[key].(string); ok && got == want {
			return true
		}
	}
	return false
}

// Nothing on these routes may log a credential. Not the key, not a prefix, not
// its length.
func (l *delLogs) Contains(needle string) bool {
	return strings.Contains(l.buf.String(), needle)
}

// delValidationLoc pulls the `loc` path out of a Shape D validation body.
func delValidationLoc(t *testing.T, body []byte) []string {
	t.Helper()
	var parsed struct {
		Detail []struct {
			Loc []string `json:"loc"`
		} `json:"detail"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("validation body: %v (%s)", err, body)
	}
	if len(parsed.Detail) == 0 {
		return nil
	}
	return parsed.Detail[0].Loc
}

func delContains(haystack []string, needle string) bool {
	for _, item := range haystack {
		if item == needle {
			return true
		}
	}
	return false
}

type delDeps struct {
	internalKey  string
	e2eEnabled   bool
	deletedCount int64
	deleteErr    error

	logs        *delLogs
	deleter     *delFakeUserDeleter
	tagDeleter  *delFakeTagDeleter
	invalidator *delFakeInvalidator
}

// newDelRouter builds the real router with the two delete routes registered the
// way main.go registers them, so the 405-vs-404 behaviour under the flag is
// exercised against genuine Gin routing rather than a hand-made engine.
func newDelRouter(t *testing.T, deps *delDeps) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	buf := &bytes.Buffer{}
	deps.logs = &delLogs{buf: buf}
	log := slog.New(slog.NewJSONHandler(buf, nil))

	deps.deleter = &delFakeUserDeleter{count: deps.deletedCount, err: deps.deleteErr}
	deps.tagDeleter = &delFakeTagDeleter{count: deps.deletedCount, err: deps.deleteErr}
	deps.invalidator = &delFakeInvalidator{}

	router := adapterhttp.NewRouter()

	// The parameterised read route exists in the GET tree. It is what makes a
	// DELETE to /v1/trackings/e2e-cleanup a 405 rather than a 404 when the flag
	// is off, so the test must register it too.
	router.GET("/v1/trackings/:order_id", func(c *gin.Context) { c.Status(nethttp.StatusOK) })

	internalDelete := adapterhttp.NewInternalDeleteHandler(
		app.NewDeleteByUser(deps.deleter, deps.invalidator, nil), log, nil)
	internal := router.Group("/v1/trackings", adapterhttp.RequireInternalKey(deps.internalKey, log))
	internal.DELETE("/by-user", internalDelete.Handle)

	if deps.e2eEnabled {
		cleanup := adapterhttp.NewE2ECleanupHandler(
			app.NewE2ECleanup(deps.tagDeleter, nil), log, nil)
		router.DELETE("/v1/trackings/e2e-cleanup", cleanup.Handle)
	}

	return router
}

func doDelete(t *testing.T, deps *delDeps, apiKey, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	router := newDelRouter(t, deps)

	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}

	// NewRequestWithContext, never NewRequest: noctx rejects the latter, and a
	// request without a context cannot be cancelled or traced.
	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodDelete, path, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if apiKey != "" {
		req.Header.Set("x-api-key", apiKey)
	}

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// ─── DELETE /v1/trackings/by-user ───────────────────────────────────────────

func TestInternalDeleteByUser(t *testing.T) {
	const key = "internal-secret"

	t.Run("200 with the count", func(t *testing.T) {
		deps := &delDeps{internalKey: key, deletedCount: 4}
		rec := doDelete(t, deps, key,
			"/v1/trackings/by-user", `{"cognito_sub":"sub-1","user_id":"usr_1"}`)
		if rec.Code != nethttp.StatusOK {
			t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body)
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("body: %v", err)
		}
		if body["deleted"] != float64(4) {
			t.Errorf("deleted = %v, want 4", body["deleted"])
		}
	})

	// The two identities must reach the row-selection point AS SENT and in the
	// right slots. They are DIFFERENT values here on purpose: a test reusing one
	// string for both could not fail if the handler swapped them.
	t.Run("both identities reach the deleter in their own slots", func(t *testing.T) {
		deps := &delDeps{internalKey: key, deletedCount: 1}
		rec := doDelete(t, deps, key,
			"/v1/trackings/by-user", `{"cognito_sub":"sub-1","user_id":"usr_1"}`)
		if rec.Code != nethttp.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if deps.deleter.sub != "sub-1" {
			t.Errorf("cognito_sub = %q, want sub-1", deps.deleter.sub)
		}
		if deps.deleter.userID != "usr_1" {
			t.Errorf("user_id = %q, want usr_1", deps.deleter.userID)
		}
	})

	// After the write, never before, and it must not be able to fail the
	// response: the deletion has already committed.
	t.Run("the user's cache footprint is cleared after the write", func(t *testing.T) {
		deps := &delDeps{internalKey: key, deletedCount: 2}
		if rec := doDelete(t, deps, key, "/v1/trackings/by-user",
			`{"cognito_sub":"sub-1","user_id":"usr_1"}`); rec.Code != nethttp.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if !deps.invalidator.called {
			t.Fatal("the cascade did not clear the user's cache footprint")
		}
		if deps.invalidator.sub != "sub-1" || deps.invalidator.userID != "usr_1" {
			t.Errorf("invalidated (%q,%q), want (sub-1, usr_1)",
				deps.invalidator.sub, deps.invalidator.userID)
		}
	})

	t.Run("missing or wrong key is 401 shape A", func(t *testing.T) {
		for _, k := range []string{"", "wrong"} {
			deps := &delDeps{internalKey: key}
			rec := doDelete(t, deps, k,
				"/v1/trackings/by-user", `{"cognito_sub":"sub-1","user_id":"usr_1"}`)
			if rec.Code != nethttp.StatusUnauthorized {
				t.Fatalf("key %q: status = %d, want 401", k, rec.Code)
			}
			// Shape A: flat {"detail": "..."} with NO reason field.
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("body: %v", err)
			}
			if _, ok := body["detail"].(string); !ok {
				t.Errorf("key %q: body = %s, want a flat {\"detail\": \"...\"}", k, rec.Body)
			}
			// An unauthenticated request must never reach the database.
			if deps.deleter.called {
				t.Errorf("key %q reached the row-selection point", k)
			}
			// NEVER log a key, provided or expected — not even a prefix.
			if deps.logs.Contains(key) {
				t.Error("the expected api key was logged")
			}
			if k != "" && deps.logs.Contains(k) {
				t.Error("the provided api key was logged")
			}
		}
	})

	// The min-length is a SECURITY control: the downstream predicate is an OR, so
	// an empty value could widen the match to any row carrying an empty string in
	// that column.
	//
	// Each case asserts the 422 NAMES THE OFFENDING FIELD in loc. That is what
	// pins the check to THIS boundary: the use case refuses empties too, but its
	// refusal cannot say which field was at fault, so a generic 422 would pass
	// while the boundary check had been deleted.
	t.Run("an empty identity on either side is 422 naming the field", func(t *testing.T) {
		for _, tc := range []struct {
			body    string
			wantLoc string
		}{
			{`{"cognito_sub":"","user_id":"usr_1"}`, "cognito_sub"},
			{`{"cognito_sub":"sub-1","user_id":""}`, "user_id"},
			{`{"cognito_sub":"sub-1"}`, "user_id"},
			{`{"user_id":"usr_1"}`, "cognito_sub"},
			{`{}`, "cognito_sub"},
		} {
			deps := &delDeps{internalKey: key}
			rec := doDelete(t, deps, key, "/v1/trackings/by-user", tc.body)
			if rec.Code != nethttp.StatusUnprocessableEntity {
				t.Errorf("%s -> %d, want 422", tc.body, rec.Code)
				continue
			}
			// The refusal must happen at the boundary, before the statement.
			if deps.deleter.called {
				t.Errorf("%s reached the row-selection point", tc.body)
			}
			if loc := delValidationLoc(t, rec.Body.Bytes()); !delContains(loc, tc.wantLoc) {
				t.Errorf("%s -> loc %v, want it to name %q — a 422 that cannot say "+
					"which field was empty is not the boundary check doing its job",
					tc.body, loc, tc.wantLoc)
			}
		}
	})

	t.Run("unknown body fields are ACCEPTED here", func(t *testing.T) {
		// Unlike init-tracking. Do not add DisallowUnknownFields to this route.
		deps := &delDeps{internalKey: key, deletedCount: 1}
		rec := doDelete(t, deps, key, "/v1/trackings/by-user",
			`{"cognito_sub":"sub-1","user_id":"usr_1","extra":"ignored"}`)
		if rec.Code != nethttp.StatusOK {
			t.Fatalf("status = %d, want 200 — this endpoint does not forbid extras: %s",
				rec.Code, rec.Body)
		}
	})

	t.Run("a malformed body is 422", func(t *testing.T) {
		deps := &delDeps{internalKey: key}
		rec := doDelete(t, deps, key, "/v1/trackings/by-user", `{not json`)
		if rec.Code != nethttp.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422", rec.Code)
		}
	})

	t.Run("a db error is 500 and logs reason=db_error", func(t *testing.T) {
		deps := &delDeps{internalKey: key, deleteErr: errors.New("mysql gone")}
		rec := doDelete(t, deps, key, "/v1/trackings/by-user",
			`{"cognito_sub":"sub-1","user_id":"usr_1"}`)
		if rec.Code != nethttp.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rec.Code)
		}
		if !deps.logs.Has("app_event", "internal_delete_by_user_failed") ||
			!deps.logs.Has("reason", "db_error") {
			t.Error("the 500 must carry *_failed with reason=db_error — otherwise the " +
				"one outcome that most needs to be findable is the only silent one")
		}
		// A deletion that never landed has no cache footprint to clear.
		if deps.invalidator.called {
			t.Error("the cache was evicted for a failed deletion")
		}
	})

	// The success line is what an operator reads to confirm the cascade ran.
	t.Run("a success logs *_succeeded", func(t *testing.T) {
		deps := &delDeps{internalKey: key, deletedCount: 3}
		if rec := doDelete(t, deps, key, "/v1/trackings/by-user",
			`{"cognito_sub":"sub-1","user_id":"usr_1"}`); rec.Code != nethttp.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if !deps.logs.Has("app_event", "internal_delete_by_user_succeeded") {
			t.Error("the 200 must carry app_event=internal_delete_by_user_succeeded")
		}
	})
}

// ─── DELETE /v1/trackings/e2e-cleanup ───────────────────────────────────────

func TestE2ECleanupRoute(t *testing.T) {
	t.Run("registered with the flag on, 200 with a count and no credential", func(t *testing.T) {
		deps := &delDeps{e2eEnabled: true, deletedCount: 7}
		rec := doDelete(t, deps, "", "/v1/trackings/e2e-cleanup", "")
		if rec.Code != nethttp.StatusOK {
			t.Fatalf("status = %d, want 200 — this route takes NO caller identity", rec.Code)
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("body: %v", err)
		}
		if body["deleted"] != float64(7) {
			t.Errorf("deleted = %v, want 7", body["deleted"])
		}
	})

	// The tag is the only thing protecting real users' rows from this
	// unauthenticated route, so the handler must select on the exact literal.
	t.Run("selects on the E2E Source tag", func(t *testing.T) {
		deps := &delDeps{e2eEnabled: true, deletedCount: 1}
		if rec := doDelete(t, deps, "", "/v1/trackings/e2e-cleanup", ""); rec.Code != nethttp.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if deps.tagDeleter.tag != "E2E Source" {
			t.Errorf("tag = %q, want the exact literal %q", deps.tagDeleter.tag, "E2E Source")
		}
	})

	t.Run("zero matches is still 200", func(t *testing.T) {
		deps := &delDeps{e2eEnabled: true, deletedCount: 0}
		rec := doDelete(t, deps, "", "/v1/trackings/e2e-cleanup", "")
		if rec.Code != nethttp.StatusOK {
			t.Fatalf("status = %d, want 200 — a teardown re-run is not a failure", rec.Code)
		}
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("body: %v", err)
		}
		if body["deleted"] != float64(0) {
			t.Errorf("deleted = %v, want 0", body["deleted"])
		}
	})

	t.Run("with the flag OFF a DELETE is 405, not 404", func(t *testing.T) {
		deps := &delDeps{e2eEnabled: false}
		rec := doDelete(t, deps, "", "/v1/trackings/e2e-cleanup", "")
		if rec.Code != nethttp.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405 — the path still matches the GET route, "+
				"which requires gin's HandleMethodNotAllowed = true", rec.Code)
		}
		if deps.tagDeleter.called {
			t.Error("the cleanup ran with the flag off")
		}
	})

	// Neither an api key nor an x-user-id is required, and sending one changes
	// nothing: the route's protection is that it does not exist unless the flag
	// is on, plus the tag predicate.
	t.Run("a stray credential neither helps nor blocks", func(t *testing.T) {
		deps := &delDeps{e2eEnabled: true, deletedCount: 2}
		rec := doDelete(t, deps, "some-key", "/v1/trackings/e2e-cleanup", "")
		if rec.Code != nethttp.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
	})

	t.Run("a db error is 500 and logs reason=db_error", func(t *testing.T) {
		deps := &delDeps{e2eEnabled: true, deleteErr: errors.New("mysql gone")}
		rec := doDelete(t, deps, "", "/v1/trackings/e2e-cleanup", "")
		if rec.Code != nethttp.StatusInternalServerError {
			t.Fatalf("status = %d, want 500", rec.Code)
		}
		if !deps.logs.Has("app_event", "e2e_cleanup_failed") ||
			!deps.logs.Has("reason", "db_error") {
			t.Error("the 500 must carry *_failed with reason=db_error")
		}
	})

	t.Run("a success logs *_succeeded", func(t *testing.T) {
		deps := &delDeps{e2eEnabled: true, deletedCount: 5}
		if rec := doDelete(t, deps, "", "/v1/trackings/e2e-cleanup", ""); rec.Code != nethttp.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if !deps.logs.Has("app_event", "e2e_cleanup_succeeded") {
			t.Error("the 200 must carry app_event=e2e_cleanup_succeeded")
		}
		// No caller identity exists on this request, and the convention OMITS
		// unknown fields rather than emitting null or "".
		if deps.logs.Contains(`"cognito_sub"`) {
			t.Error("a cognito_sub field was emitted on a route with no caller identity")
		}
	})
}
