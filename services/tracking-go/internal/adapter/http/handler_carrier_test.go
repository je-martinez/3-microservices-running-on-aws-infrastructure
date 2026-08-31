package http_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// ─── Fixtures ────────────────────────────────────────────────────────────────

const carrierKey = "carrier-secret"

// carrierDeps is the whole configurable surface of one carrier request.
type carrierDeps struct {
	// current is the tracking's status before the request. The stub applies the
	// state machine itself, so the handler is exercised against the real guards
	// rather than against a hand-written error.
	current domain.Status
	// notFound makes the lookup answer domain.ErrTrackingNotFound.
	notFound bool
	// boom makes the transition fail with an unclassified error.
	boom error
	// key is the key the ROUTE GROUP is configured with.
	key string
}

// stubTransitioner reproduces the use case's decision order without touching a
// database: guard first, then "persist".
type stubTransitioner struct {
	deps     carrierDeps
	executed int
	gotOrder string
	gotActor audit.Actor
}

func (s *stubTransitioner) Execute(
	_ context.Context, orderID string, requested domain.Status, actor audit.Actor,
) (domain.TrackingWithHistory, error) {
	s.executed++
	s.gotOrder = orderID
	s.gotActor = actor

	if s.deps.notFound {
		return domain.TrackingWithHistory{}, domain.ErrTrackingNotFound
	}
	if s.deps.boom != nil {
		return domain.TrackingWithHistory{}, s.deps.boom
	}
	if err := domain.AssertCanTransition(s.deps.current, requested); err != nil {
		return domain.TrackingWithHistory{}, err
	}

	at := time.Date(2026, 8, 27, 15, 4, 5, 0, time.UTC)
	tracking := domain.Tracking{
		ID: "trk_1", OrderID: orderID, UserID: "usr_1", CognitoSub: "sub-1",
		TrackingNumber: "3MRAI-1111-2222-3333",
		Status:         requested, Datetime: at,
		// Present on the entity, and must appear on NO response.
		ShippingAddress: []byte(`{"street":"1 Main St"}`),
	}
	history := []domain.TrackingHistory{
		{TrackingID: "trk_1", OrderID: orderID, UserID: "usr_1", CognitoSub: "sub-1",
			Status: s.deps.current, Datetime: at.Add(-time.Hour)},
		{TrackingID: "trk_1", OrderID: orderID, UserID: "usr_1", CognitoSub: "sub-1",
			Status: requested, Datetime: at},
	}
	tracking.History = history
	return domain.TrackingWithHistory{Tracking: tracking, History: history}, nil
}

// newCarrierRouter mounts the route the way production does: the key guard is
// declared on the GROUP, not on the individual route.
func newCarrierRouter(t *testing.T, deps carrierDeps) (*gin.Engine, *stubTransitioner) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	uc := &stubTransitioner{deps: deps}
	handler := adapterhttp.NewCarrierHandler(uc, quietLogger(), nil)

	router := gin.New()
	router.Use(gin.Recovery())
	router.HandleMethodNotAllowed = true
	adapterhttp.RegisterCarrierRoutes(router, handler, deps.key)
	return router, uc
}

func quietLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError}))
}

// put issues the carrier request. httptest.NewRequestWithContext, never
// httptest.NewRequest: the latter is rejected by noctx.
func put(t *testing.T, router *gin.Engine, apiKey, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodPut,
		"/v1/trackings/ord_1/status", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("x-api-key", apiKey)
	}
	router.ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not a JSON object: %s", rec.Body)
	}
	return body
}

// ─── Tests ───────────────────────────────────────────────────────────────────

func TestCarrierPut(t *testing.T) {
	t.Run("200 is a FLAT TrackingResponse", func(t *testing.T) {
		router, uc := newCarrierRouter(t, carrierDeps{key: carrierKey, current: domain.StatusPlaced})
		rec := put(t, router, carrierKey, `{"status":"PROCESSING"}`)

		if rec.Code != nethttp.StatusOK {
			t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body)
		}
		body := decodeBody(t, rec)
		if _, wrapped := body["tracking"]; wrapped {
			t.Fatal("the carrier PUT must return a FLAT TrackingResponse; only " +
				"init-tracking's 201 is wrapped under a tracking key")
		}
		if body["status"] != "PROCESSING" {
			t.Errorf("status = %v, want PROCESSING", body["status"])
		}
		if uc.gotOrder != "ord_1" {
			t.Errorf("use case received order %q, want the path parameter ord_1", uc.gotOrder)
		}
		// The handler passes the ZERO actor so the use case applies its own
		// default. Naming the carrier actor here would put the default in two
		// places, and Wave 2.5's caller would be the only one that could keep
		// them in step.
		if uc.gotActor != "" {
			t.Errorf("handler passed actor %q, want the zero value so the use case "+
				"owns the default", uc.gotActor)
		}
	})

	t.Run("neither shipping_address nor cognito_sub appears on the response", func(t *testing.T) {
		router, _ := newCarrierRouter(t, carrierDeps{key: carrierKey, current: domain.StatusPlaced})
		rec := put(t, router, carrierKey, `{"status":"SHIPPED"}`)

		raw := rec.Body.String()
		for _, forbidden := range []string{"shipping_address", "cognito_sub"} {
			if strings.Contains(raw, forbidden) {
				t.Errorf("%q appears in the response body: %s", forbidden, raw)
			}
		}
	})

	t.Run("datetime is the ISO string form, never RFC3339", func(t *testing.T) {
		router, _ := newCarrierRouter(t, carrierDeps{key: carrierKey, current: domain.StatusPlaced})
		rec := put(t, router, carrierKey, `{"status":"SHIPPED"}`)

		body := decodeBody(t, rec)
		got, _ := body["datetime"].(string)
		if got != "2026-08-27T15:04:05Z" {
			t.Errorf("datetime = %q, want 2026-08-27T15:04:05Z — isoformat()+\"Z\", "+
				"not RFC3339 (which would render +00:00 or a fixed fractional width)", got)
		}
	})

	t.Run("missing and wrong keys are the SAME 401 body", func(t *testing.T) {
		router, uc := newCarrierRouter(t, carrierDeps{key: carrierKey, current: domain.StatusPlaced})
		missing := put(t, router, "", `{"status":"SHIPPED"}`)
		wrong := put(t, router, "not-the-key", `{"status":"SHIPPED"}`)

		for name, rec := range map[string]*httptest.ResponseRecorder{"missing": missing, "wrong": wrong} {
			if rec.Code != nethttp.StatusUnauthorized {
				t.Fatalf("%s key: status = %d, want 401 (body %s)", name, rec.Code, rec.Body)
			}
		}
		if missing.Body.String() != wrong.Body.String() {
			t.Fatalf("bodies differ: %s vs %s — both must be identical, so the "+
				"endpoint cannot be used to tell a NEARLY-right key from an absent one",
				missing.Body, wrong.Body)
		}
		body := decodeBody(t, missing)
		if body["detail"] != "invalid api key" {
			t.Errorf("detail = %v, want \"invalid api key\"", body["detail"])
		}
		if _, present := body["reason"]; present {
			t.Error("the 401 is shape A — no reason field")
		}
		if uc.executed != 0 {
			t.Error("an unauthenticated request reached the use case")
		}
	})

	t.Run("the key guard is on the ROUTE GROUP, not one route", func(t *testing.T) {
		// A second carrier endpoint added to this group must be authenticated by
		// DEFAULT rather than open by default. Registering the guard per-route is
		// how the next endpoint ships unprotected.
		router, _ := newCarrierRouter(t, carrierDeps{key: carrierKey, current: domain.StatusPlaced})

		// The group's own middleware answers before any handler runs, which is
		// observable: an unauthenticated request to the group gets the group's
		// 401 rather than a per-route response.
		rec := put(t, router, "", `{"status":"SHIPPED"}`)
		if rec.Code != nethttp.StatusUnauthorized {
			t.Fatalf("status = %d, want 401 from the group guard", rec.Code)
		}

		// And every route the registrar mounts sits under the same prefix, so a
		// future sibling inherits the guard rather than opting into it.
		var guarded int
		for _, route := range router.Routes() {
			if strings.HasPrefix(route.Path, "/v1/trackings/") {
				guarded++
			}
		}
		if guarded == 0 {
			t.Fatal("no carrier route was registered under /v1/trackings/")
		}
	})

	t.Run("no x-user-id is ever required", func(t *testing.T) {
		// A carrier request carries no x-user-id at all. If the reads' identity
		// middleware leaked onto this group, this would be a 401 — and every
		// carrier call would fail while the endpoint looked implemented.
		router, _ := newCarrierRouter(t, carrierDeps{key: carrierKey, current: domain.StatusPlaced})
		rec := put(t, router, carrierKey, `{"status":"PROCESSING"}`)

		if rec.Code == nethttp.StatusUnauthorized {
			t.Fatal("the carrier PUT acquired an x-user-id requirement")
		}
		if rec.Code != nethttp.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
	})

	t.Run("an unknown status is 400 shape C with the exact message", func(t *testing.T) {
		router, uc := newCarrierRouter(t, carrierDeps{key: carrierKey, current: domain.StatusPlaced})
		rec := put(t, router, carrierKey, `{"status":"FOO"}`)

		if rec.Code != nethttp.StatusBadRequest {
			t.Fatalf("status = %d, want 400 (NOT 422 — the body binds status as a "+
				"BARE STRING so all four failure reasons answer alike): %s", rec.Code, rec.Body)
		}
		body := decodeBody(t, rec)
		want := "invalid tracking status 'FOO'; expected one of: " +
			"PLACED, PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED"
		if body["detail"] != want {
			t.Errorf("detail = %q, want %q", body["detail"], want)
		}
		if body["reason"] != "invalid_status" {
			t.Errorf("reason = %v, want invalid_status (TOP LEVEL, not nested)", body["reason"])
		}
		if _, nested := body["detail"].(map[string]any); nested {
			t.Error("the carrier 400 is FLAT with a top-level reason (shape C)")
		}
		if uc.executed != 0 {
			t.Error("an unparseable status reached the use case; nothing must be " +
				"read or written for it")
		}
	})

	t.Run("each guard surfaces its own reason at 400", func(t *testing.T) {
		cases := []struct {
			current    domain.Status
			requested  string
			wantReason string
		}{
			// Guard order is load-bearing: terminality is reported first, so
			// DELIVERED -> PLACED is already_delivered even though it is also
			// backward.
			{domain.StatusDelivered, "PLACED", "already_delivered"},
			{domain.StatusDelivered, "DELIVERED", "already_delivered"},
			{domain.StatusShipped, "PLACED", "backward_transition"},
			{domain.StatusShipped, "SHIPPED", "not_strictly_forward"},
		}
		for _, tc := range cases {
			t.Run(fmt.Sprintf("%s_to_%s", tc.current, tc.requested), func(t *testing.T) {
				router, _ := newCarrierRouter(t, carrierDeps{key: carrierKey, current: tc.current})
				rec := put(t, router, carrierKey, fmt.Sprintf(`{"status":%q}`, tc.requested))

				if rec.Code != nethttp.StatusBadRequest {
					t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body)
				}
				body := decodeBody(t, rec)
				if body["reason"] != tc.wantReason {
					t.Errorf("reason = %v, want %q", body["reason"], tc.wantReason)
				}
				if _, nested := body["detail"].(map[string]any); nested {
					t.Error("the carrier 400 is FLAT with a top-level reason (shape C), " +
						"not the nested shape init-tracking uses")
				}
				if _, ok := body["detail"].(string); !ok {
					t.Errorf("detail is %T, want a string", body["detail"])
				}
			})
		}
	})

	t.Run("an unknown order is 404 shape A", func(t *testing.T) {
		router, _ := newCarrierRouter(t, carrierDeps{key: carrierKey, notFound: true})
		rec := put(t, router, carrierKey, `{"status":"SHIPPED"}`)

		if rec.Code != nethttp.StatusNotFound {
			t.Fatalf("status = %d, want 404: %s", rec.Code, rec.Body)
		}
		body := decodeBody(t, rec)
		if body["detail"] != "tracking not found" {
			t.Errorf("detail = %v, want \"tracking not found\"", body["detail"])
		}
		if _, present := body["reason"]; present {
			t.Error("the 404 is shape A — no reason field")
		}
	})

	t.Run("a body that never carried a status string is 422, not 400", func(t *testing.T) {
		// This is the ONE failure on this route that is not a 400: the request
		// never got as far as having a status VALUE to reject, so it is a
		// malformed body rather than an unacceptable transition. A handler that
		// let these fall through to ParseStatus would answer 400 with
		// reason=invalid_status for a body that has no status field at all.
		for name, payload := range map[string]string{
			"empty":      ``,
			"not json":   `not json`,
			"wrong type": `{"status":123}`,
			"array body": `[]`,
		} {
			t.Run(name, func(t *testing.T) {
				router, uc := newCarrierRouter(t, carrierDeps{key: carrierKey, current: domain.StatusPlaced})
				rec := put(t, router, carrierKey, payload)
				if rec.Code != nethttp.StatusUnprocessableEntity {
					t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body)
				}
				if uc.executed != 0 {
					t.Error("a malformed body reached the use case")
				}
			})
		}
	})

	t.Run("an ABSENT status is 422 Field required, never 400", func(t *testing.T) {
		// Pydantic declares `status: str` — required and non-nullable — so the
		// Python answers 422 for {} and for {"status": null}. Go's encoding/json
		// decodes both into "" on a plain string field, which would answer 400
		// with reason=invalid_status instead. Verified against the running
		// service on 2026-08-27.
		for name, payload := range map[string]string{
			"missing key":   `{}`,
			"explicit null": `{"status":null}`,
		} {
			t.Run(name, func(t *testing.T) {
				router, uc := newCarrierRouter(t, carrierDeps{key: carrierKey, current: domain.StatusPlaced})
				rec := put(t, router, carrierKey, payload)
				if rec.Code != nethttp.StatusUnprocessableEntity {
					t.Fatalf("status = %d, want 422: %s", rec.Code, rec.Body)
				}
				var body adapterhttp.ValidationError
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatalf("422 body is not the validation shape: %s", rec.Body)
				}
				if len(body.Detail) != 1 {
					t.Fatalf("detail has %d entries, want a single-entry LIST", len(body.Detail))
				}
				if got := body.Detail[0].Loc; len(got) != 2 || got[1] != "status" {
					t.Errorf("loc = %v, want [body status]", got)
				}
				if body.Detail[0].Typ != "missing" {
					t.Errorf("type = %q, want missing", body.Detail[0].Typ)
				}
				if uc.executed != 0 {
					t.Error("a body with no status reached the use case")
				}
			})
		}
	})

	t.Run("an EMPTY status string is 400 invalid_status", func(t *testing.T) {
		// Present but not one of the five: the same vocabulary as any other
		// unacceptable value, and distinct from the absent case above.
		router, _ := newCarrierRouter(t, carrierDeps{key: carrierKey, current: domain.StatusPlaced})
		rec := put(t, router, carrierKey, `{"status":""}`)
		if rec.Code != nethttp.StatusBadRequest {
			t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body)
		}
		if body := decodeBody(t, rec); body["reason"] != "invalid_status" {
			t.Errorf("reason = %v, want invalid_status", body["reason"])
		}
	})

	t.Run("an unclassified failure is a 500 that leaks nothing", func(t *testing.T) {
		router, _ := newCarrierRouter(t, carrierDeps{
			key: carrierKey, boom: fmt.Errorf("mysql: connection refused to 10.0.0.4:3306"),
		})
		rec := put(t, router, carrierKey, `{"status":"SHIPPED"}`)

		if rec.Code != nethttp.StatusInternalServerError {
			t.Fatalf("status = %d, want 500: %s", rec.Code, rec.Body)
		}
		body := decodeBody(t, rec)
		if body["detail"] != "internal server error" {
			t.Errorf("detail = %v, want a generic message", body["detail"])
		}
		if strings.Contains(rec.Body.String(), "10.0.0.4") {
			t.Error("the 500 body leaked infrastructure detail")
		}
	})

	t.Run("the failure log carries a reason and never the api key", func(t *testing.T) {
		var captured strings.Builder
		log := slog.New(slog.NewJSONHandler(&captured, &slog.HandlerOptions{Level: slog.LevelDebug}))

		gin.SetMode(gin.TestMode)
		handler := adapterhttp.NewCarrierHandler(
			&stubTransitioner{deps: carrierDeps{current: domain.StatusShipped}}, log, nil)
		router := gin.New()
		router.Use(gin.Recovery())
		adapterhttp.RegisterCarrierRoutes(router, handler, carrierKey)

		if rec := put(t, router, carrierKey, `{"status":"PLACED"}`); rec.Code != nethttp.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}

		lines := captured.String()
		if !strings.Contains(lines, `"app_event":"carrier_status_update_failed"`) {
			t.Errorf("no *_failed event was logged: %s", lines)
		}
		if !strings.Contains(lines, `"reason":"backward_transition"`) {
			t.Errorf("the failure line carries no machine-readable reason: %s", lines)
		}
		// NEVER the key, not even a prefix or a length. And no user_id field:
		// this request has no user identity, and the convention OMITS unknown
		// fields rather than emitting null.
		if strings.Contains(lines, carrierKey) {
			t.Error("the api key was logged")
		}
		if strings.Contains(lines, `"user_id"`) || strings.Contains(lines, `"cognito_sub"`) {
			t.Errorf("an identity field was logged for a request that carries none: %s", lines)
		}
	})

	t.Run("the success log names the transition without PII", func(t *testing.T) {
		var captured strings.Builder
		log := slog.New(slog.NewJSONHandler(&captured, &slog.HandlerOptions{Level: slog.LevelDebug}))

		gin.SetMode(gin.TestMode)
		handler := adapterhttp.NewCarrierHandler(
			&stubTransitioner{deps: carrierDeps{current: domain.StatusPlaced}}, log, nil)
		router := gin.New()
		router.Use(gin.Recovery())
		adapterhttp.RegisterCarrierRoutes(router, handler, carrierKey)

		if rec := put(t, router, carrierKey, `{"status":"SHIPPED"}`); rec.Code != nethttp.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}

		lines := captured.String()
		if !strings.Contains(lines, `"app_event":"carrier_status_update_succeeded"`) {
			t.Errorf("no *_succeeded event: %s", lines)
		}
		// There is NO SUCCESS severity — success is INFO plus app_event=*_succeeded.
		if !strings.Contains(lines, `"level":"INFO"`) {
			t.Errorf("success was not logged at INFO: %s", lines)
		}
		for _, forbidden := range []string{"shipping_address", "1 Main St", carrierKey} {
			if strings.Contains(lines, forbidden) {
				t.Errorf("%q was logged", forbidden)
			}
		}
	})

	t.Run("a wrong method on the path is 405, not 404", func(t *testing.T) {
		router, _ := newCarrierRouter(t, carrierDeps{key: carrierKey, current: domain.StatusPlaced})
		rec := httptest.NewRecorder()
		req := httptest.NewRequestWithContext(t.Context(), nethttp.MethodPost,
			"/v1/trackings/ord_1/status", strings.NewReader(`{}`))
		router.ServeHTTP(rec, req)

		if rec.Code != nethttp.StatusMethodNotAllowed {
			t.Errorf("status = %d, want 405 — the path exists under another method", rec.Code)
		}
	})
}
