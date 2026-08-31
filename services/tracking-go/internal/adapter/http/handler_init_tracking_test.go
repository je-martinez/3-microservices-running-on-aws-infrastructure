package http_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/trace/noop"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/app"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

// errInitUsersUnavailable stands in for every gRPC status that is NOT NotFound. It
// must never be rendered as "unknown user".
var errInitUsersUnavailable = errors.New("rpc error: code = Unavailable")

func initPtr[T any](v T) *T { return &v }

// ─── Fakes ───────────────────────────────────────────────────────────────────

type initFakeResolver struct {
	userID string
	err    error
}

func (f initFakeResolver) ResolveInternalUserID(context.Context, string) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	if f.userID == "" {
		return "usr_internal", nil
	}
	return f.userID, nil
}

// initFakeWriter records the commit ordering so a hook that fires too early is
// observable rather than merely suspected.
type initFakeWriter struct {
	mu        sync.Mutex
	exists    bool
	createErr error
	committed bool
	got       domain.NewTracking
}

func (f *initFakeWriter) ExistsByOrderID(context.Context, string) (bool, error) {
	return f.exists, nil
}

func (f *initFakeWriter) Create(
	_ context.Context, in domain.NewTracking, now time.Time,
) (domain.TrackingWithHistory, error) {
	if f.createErr != nil {
		return domain.TrackingWithHistory{}, f.createErr
	}
	f.mu.Lock()
	f.got = in
	f.committed = true
	f.mu.Unlock()
	return domain.TrackingWithHistory{
		Tracking: domain.Tracking{
			ID: "trk_test", OrderID: in.OrderID, UserID: in.UserID,
			CognitoSub: in.CognitoSub, Status: domain.StatusPlaced, Datetime: now,
			ShippingAddress: in.ShippingAddress,
		},
		History: []domain.TrackingHistory{{
			TrackingID: "trk_test", OrderID: in.OrderID, UserID: in.UserID,
			Status: domain.StatusPlaced, Datetime: now,
		}},
	}, nil
}

func (f *initFakeWriter) Committed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.committed
}

// initRecordingHook captures whether Start ran and whether the write had already
// committed when it did.
type initRecordingHook struct {
	mu             sync.Mutex
	writer         *initFakeWriter
	started        map[string]bool
	snapshot       domain.TrackingWithHistory
	beforeCommit   bool
	invocationSeen bool
}

func newInitRecordingHook(w *initFakeWriter) *initRecordingHook {
	return &initRecordingHook{writer: w, started: map[string]bool{}}
}

func (h *initRecordingHook) Start(tracking domain.TrackingWithHistory) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.invocationSeen = true
	h.started[tracking.Tracking.OrderID] = true
	h.snapshot = tracking
	if h.writer != nil && !h.writer.Committed() {
		h.beforeCommit = true
	}
}

func (h *initRecordingHook) Snapshot() domain.TrackingWithHistory {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.snapshot
}

func (h *initRecordingHook) Started(orderID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.started[orderID]
}

func (h *initRecordingHook) StartedBeforeCommit() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.beforeCommit
}

// initCountingPublisher proves creation emits NOTHING. Only transitions publish.
type initCountingPublisher struct {
	mu sync.Mutex
	n  int
}

func (p *initCountingPublisher) Count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.n
}

// ─── Harness ─────────────────────────────────────────────────────────────────

type initDeps struct {
	resolverErr   error
	alreadyExists bool
	createErr     error
	e2eEnabled    bool

	hook      *initRecordingHook
	publisher *initCountingPublisher
	writer    *initFakeWriter
}

func newInitRouter(t *testing.T, deps *initDeps) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	deps.writer = &initFakeWriter{exists: deps.alreadyExists, createErr: deps.createErr}
	deps.hook = newInitRecordingHook(deps.writer)
	deps.publisher = &initCountingPublisher{}

	uc := app.NewCreateTracking(
		initFakeResolver{err: deps.resolverErr},
		deps.writer,
		func() time.Time { return time.Date(2026, 8, 27, 14, 53, 1, 0, time.UTC) },
	)
	handler := adapterhttp.NewInitTrackingHandler(
		uc, deps.hook,
		slog.New(slog.NewJSONHandler(io.Discard, nil)),
		noop.NewTracerProvider().Tracer("test"),
	)

	router := gin.New()
	router.Use(adapterhttp.E2ESourceMiddleware(deps.e2eEnabled), adapterhttp.TestModeMiddleware())
	// Through the exported registrar, not a hand-written route: a test that mounts
	// its own path proves the handler works at a path production may never serve.
	adapterhttp.RegisterInitTracking(router, handler)
	return router
}

func postInit(t *testing.T, router *gin.Engine, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodPost,
		"/v1/trackings/init-tracking", strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	router.ServeHTTP(rec, req)
	return rec
}

// ─── Tests ───────────────────────────────────────────────────────────────────

func TestInitTrackingHandler(t *testing.T) {
	authed := map[string]string{"x-user-id": "sub-abc"}

	t.Run("201 wraps the tracking under a tracking key", func(t *testing.T) {
		rec := postInit(t, newInitRouter(t, &initDeps{}), `{"order_id":"ord_1"}`, authed)

		if rec.Code != nethttp.StatusCreated {
			t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body)
		}
		var body map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if _, ok := body["tracking"]; !ok {
			t.Fatalf("201 body is not wrapped under \"tracking\": %s", rec.Body)
		}
		var inner map[string]any
		if err := json.Unmarshal(body["tracking"], &inner); err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{"shipping_address", "cognito_sub"} {
			if _, present := inner[forbidden]; present {
				t.Errorf("%q must never appear on a response", forbidden)
			}
		}
		if _, ok := inner["history"]; !ok {
			t.Error("the 201 body must carry the first history row")
		}
		// datetime is a STRING with a Z suffix, never RFC3339 and never null.
		if got, ok := inner["datetime"].(string); !ok || got != "2026-08-27T14:53:01Z" {
			t.Errorf("datetime = %#v, want the ISO string 2026-08-27T14:53:01Z", inner["datetime"])
		}
	})

	t.Run("identity comes from the header, never the body", func(t *testing.T) {
		deps := &initDeps{}
		rec := postInit(t, newInitRouter(t, deps), `{"order_id":"ord_1"}`,
			map[string]string{"x-user-id": "sub-header-wins"})
		if rec.Code != nethttp.StatusCreated {
			t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body)
		}
		if deps.writer.got.CognitoSub != "sub-header-wins" {
			t.Errorf("cognito_sub = %q, want the x-user-id value verbatim",
				deps.writer.got.CognitoSub)
		}
		// user_id and cognito_sub are DIFFERENT values, so a swap is detectable.
		if deps.writer.got.UserID != "usr_internal" {
			t.Errorf("user_id = %q, want the RESOLVED usr_ id", deps.writer.got.UserID)
		}
	})

	t.Run("an unknown body field is 422 NAMING the field", func(t *testing.T) {
		rec := postInit(t, newInitRouter(t, &initDeps{}),
			`{"order_id":"ord_1","user_id":"usr_someone_else"}`, authed)

		if rec.Code != nethttp.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422 — encoding/json silently ignores unknown "+
				"fields unless DisallowUnknownFields is set", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "user_id") {
			t.Errorf("422 body must name the offending field: %s", rec.Body)
		}
		// Shape D: {"detail":[{"loc":[...],"msg":...,"type":...}]}
		var body struct {
			Detail []struct {
				Loc []string `json:"loc"`
				Msg string   `json:"msg"`
				Typ string   `json:"type"`
			} `json:"detail"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || len(body.Detail) == 0 {
			t.Fatalf("422 is not the FastAPI validation shape: %s", rec.Body)
		}
		if got := body.Detail[0].Loc; len(got) != 2 || got[0] != "body" || got[1] != "user_id" {
			t.Errorf("loc = %v, want [body user_id]", got)
		}
	})

	t.Run("shipping_address accepts an arbitrary object", func(t *testing.T) {
		deps := &initDeps{}
		rec := postInit(t, newInitRouter(t, deps),
			`{"order_id":"ord_1","shipping_address":{"street":"a","future_field":{"deep":1}}}`,
			authed)

		if rec.Code != nethttp.StatusCreated {
			t.Fatalf("status = %d, want 201 — the address is free-form by design: %s",
				rec.Code, rec.Body)
		}
		if !strings.Contains(string(deps.writer.got.ShippingAddress), "future_field") {
			t.Errorf("shipping_address stored as %s, want the raw object preserved",
				deps.writer.got.ShippingAddress)
		}
	})

	t.Run("an absent shipping_address is stored as NULL, never as an empty object", func(t *testing.T) {
		deps := &initDeps{}
		if rec := postInit(t, newInitRouter(t, deps), `{"order_id":"ord_1"}`, authed); rec.Code != nethttp.StatusCreated {
			t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body)
		}
		if deps.writer.got.ShippingAddress != nil {
			t.Errorf("shipping_address = %s, want nil (the column stays NULL)",
				deps.writer.got.ShippingAddress)
		}
	})

	t.Run("order_id longer than 28 is 422", func(t *testing.T) {
		rec := postInit(t, newInitRouter(t, &initDeps{}),
			`{"order_id":"`+strings.Repeat("a", 29)+`"}`, authed)
		if rec.Code != nethttp.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422", rec.Code)
		}
	})

	t.Run("order_id of exactly 28 is accepted", func(t *testing.T) {
		// The boundary matters: an off-by-one here rejects every real trk_/ord_ id,
		// which are exactly 28 characters wide.
		rec := postInit(t, newInitRouter(t, &initDeps{}),
			`{"order_id":"`+strings.Repeat("a", 28)+`"}`, authed)
		if rec.Code != nethttp.StatusCreated {
			t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body)
		}
	})

	t.Run("an empty order_id is 422", func(t *testing.T) {
		rec := postInit(t, newInitRouter(t, &initDeps{}), `{"order_id":""}`, authed)
		if rec.Code != nethttp.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422", rec.Code)
		}
	})

	t.Run("malformed json is 422, not 500", func(t *testing.T) {
		rec := postInit(t, newInitRouter(t, &initDeps{}), `{"order_id":`, authed)
		if rec.Code != nethttp.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422", rec.Code)
		}
	})

	t.Run("missing and empty x-user-id are both 401 shape A", func(t *testing.T) {
		for name, header := range map[string]*string{
			"absent": nil,
			"empty":  initPtr(""),
		} {
			t.Run(name, func(t *testing.T) {
				headers := map[string]string{}
				if header != nil {
					headers["x-user-id"] = *header
				}
				rec := postInit(t, newInitRouter(t, &initDeps{}), `{"order_id":"ord_1"}`, headers)

				if rec.Code != nethttp.StatusUnauthorized {
					t.Fatalf("status = %d, want 401", rec.Code)
				}
				var body map[string]any
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if body["detail"] != "missing x-user-id" {
					t.Errorf("body = %s, want flat {\"detail\":\"missing x-user-id\"}", rec.Body)
				}
			})
		}
	})

	t.Run("404 and 409 use the NESTED body shape", func(t *testing.T) {
		cases := []struct {
			name     string
			deps     initDeps
			wantCode int
			wantRsn  string
		}{
			{"unknown user", initDeps{resolverErr: domain.ErrUserNotFound}, 404, "unknown_user"},
			{"already exists", initDeps{alreadyExists: true}, 409, "tracking_already_exists"},
			{
				"racing insert", initDeps{createErr: domain.ErrTrackingAlreadyExists},
				409, "tracking_already_exists",
			},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				deps := tc.deps
				rec := postInit(t, newInitRouter(t, &deps), `{"order_id":"ord_1"}`, authed)

				if rec.Code != tc.wantCode {
					t.Fatalf("status = %d, want %d: %s", rec.Code, tc.wantCode, rec.Body)
				}
				// The NESTED shape: detail must be an OBJECT, so decoding into a
				// string field has to fail.
				var flat struct {
					Detail string `json:"detail"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &flat); err == nil {
					t.Fatalf("body is FLAT; the 404/409 on this route are NESTED "+
						"(the openapi.yaml is wrong here, the Python CODE is right): %s",
						rec.Body)
				}
				var body struct {
					Detail struct {
						Detail string `json:"detail"`
						Reason string `json:"reason"`
					} `json:"detail"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatalf("body is not the NESTED shape: %s", rec.Body)
				}
				if body.Detail.Reason != tc.wantRsn {
					t.Errorf("reason = %q, want %q (body %s)", body.Detail.Reason, tc.wantRsn, rec.Body)
				}
				if body.Detail.Detail == "" {
					t.Errorf("the nested detail must carry a message: %s", rec.Body)
				}
			})
		}
	})

	t.Run("a non-NotFound gRPC failure is 500, never 404", func(t *testing.T) {
		rec := postInit(t, newInitRouter(t, &initDeps{resolverErr: errInitUsersUnavailable}),
			`{"order_id":"ord_1"}`, authed)

		if rec.Code != nethttp.StatusInternalServerError {
			t.Fatalf("status = %d, want 500 — an outage must not read as unknown user: %s",
				rec.Code, rec.Body)
		}
		// The 500 must not leak the transport error to the client either.
		if strings.Contains(rec.Body.String(), "Unavailable") {
			t.Errorf("the 500 body leaks the transport error: %s", rec.Body)
		}
	})

	t.Run("creation emits NO sqs event", func(t *testing.T) {
		deps := &initDeps{}
		rec := postInit(t, newInitRouter(t, deps), `{"order_id":"ord_1"}`, authed)
		if rec.Code != nethttp.StatusCreated {
			t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body)
		}
		if n := deps.publisher.Count(); n != 0 {
			t.Fatalf("creation published %d events, want 0 — only status updates emit", n)
		}
	})

	t.Run("the progression hook fires only for x-test-mode and only after commit", func(t *testing.T) {
		deps := &initDeps{}
		rec := postInit(t, newInitRouter(t, deps), `{"order_id":"ord_1"}`,
			map[string]string{"x-user-id": "sub-abc", "x-test-mode": "true"})
		if rec.Code != nethttp.StatusCreated {
			t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body)
		}
		if !deps.hook.Started("ord_1") {
			t.Fatal("x-test-mode did not invoke the progression hook")
		}
		if deps.hook.StartedBeforeCommit() {
			t.Fatal("the hook ran before the transaction committed — its snapshot " +
				"would not be authoritative")
		}
		snapshot := deps.hook.Snapshot()
		if snapshot.Tracking.Status != domain.StatusPlaced || len(snapshot.History) != 1 {
			t.Fatalf("hook snapshot = %+v, want the committed PLACED row and history", snapshot)
		}
	})

	t.Run("without x-test-mode the hook never fires", func(t *testing.T) {
		deps := &initDeps{}
		postInit(t, newInitRouter(t, deps), `{"order_id":"ord_1"}`, authed)
		if deps.hook.Started("ord_1") {
			t.Fatal("the hook fired without x-test-mode")
		}
	})

	t.Run("a failed creation never fires the hook", func(t *testing.T) {
		deps := &initDeps{alreadyExists: true}
		postInit(t, newInitRouter(t, deps), `{"order_id":"ord_1"}`,
			map[string]string{"x-user-id": "sub-abc", "x-test-mode": "true"})
		if deps.hook.Started("ord_1") {
			t.Fatal("the hook fired for a request that created nothing")
		}
	})

	t.Run("the e2e tag needs BOTH the header and the enabled flag", func(t *testing.T) {
		cases := []struct {
			name    string
			enabled bool
			header  string
			wantTag bool
		}{
			{"header and flag", true, "true", true},
			{"header without the flag", false, "true", false},
			{"flag without the header", true, "", false},
			{"neither", false, "", false},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				deps := &initDeps{e2eEnabled: tc.enabled}
				headers := map[string]string{"x-user-id": "sub-abc"}
				if tc.header != "" {
					headers["x-e2e-source"] = tc.header
				}
				if rec := postInit(t, newInitRouter(t, deps), `{"order_id":"ord_1"}`, headers); rec.Code != nethttp.StatusCreated {
					t.Fatalf("status = %d, want 201: %s", rec.Code, rec.Body)
				}
				gotTag := len(deps.writer.got.Tags) == 1 &&
					deps.writer.got.Tags[0] == domain.E2ESourceTag
				if gotTag != tc.wantTag {
					t.Errorf("tags = %v, want tagged=%v", deps.writer.got.Tags, tc.wantTag)
				}
			})
		}
	})
}
