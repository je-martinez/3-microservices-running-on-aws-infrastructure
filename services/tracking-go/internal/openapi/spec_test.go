package openapi_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/goccy/go-yaml"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/openapi"
)

// pythonSpecPath is the committed contract the Go service must reproduce. It is
// read from the SIBLING service rather than copied here: a copy would be a second
// source of truth, and the whole point of this test is that there is one.
const pythonSpecPath = "../../../tracking/openapi.yaml"

func loadYAML(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(path))
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return doc
}

func TestSpecRunsWithoutADatabase(t *testing.T) {
	// No fixture, no TRACKING_DATABASE_URL, no skip. The document is a
	// routing-table fact and this test must run in every suite — which is
	// precisely the suite that runs when no MySQL is reachable, i.e. when a
	// wiring mistake is likeliest to go unnoticed.
	if got := openapi.BuildSpec(); len(got) == 0 {
		t.Fatal("BuildSpec returned an empty document")
	}
}

func TestEveryRouteIsDescribed(t *testing.T) {
	spec := openapi.BuildSpec()
	paths, _ := spec["paths"].(map[string]any)

	want := map[string][]string{
		"/v1/health":                      {"get"},
		"/v1/trackings/init-tracking":     {"post"},
		"/v1/trackings":                   {"get"},
		"/v1/trackings/{order_id}":        {"get"},
		"/v1/trackings/{order_id}/status": {"put"},
		"/v1/trackings/by-user":           {"delete"},
		"/v1/trackings/e2e-cleanup":       {"delete"},
	}
	for path, methods := range want {
		item, ok := paths[path].(map[string]any)
		if !ok {
			t.Errorf("path %s is absent from the generated document", path)
			continue
		}
		for _, m := range methods {
			if _, ok := item[m]; !ok {
				t.Errorf("%s %s is absent", m, path)
			}
		}
	}
	if len(paths) != len(want) {
		t.Errorf("the document describes %d paths, want %d — a route added without "+
			"a spec entry is an incomplete change", len(paths), len(want))
	}
}

func TestDeclaredFailuresTheFrameworkCannotInfer(t *testing.T) {
	spec := openapi.BuildSpec()
	paths := spec["paths"].(map[string]any)

	cases := []struct {
		path, method string
		codes        []string
	}{
		{"/v1/trackings/init-tracking", "post", []string{"201", "401", "404", "409", "422"}},
		// Both reads shipped without their 401 in the Python service for exactly
		// this reason: it comes from middleware, which no framework can infer.
		{"/v1/trackings", "get", []string{"200", "400", "401", "422"}},
		{"/v1/trackings/{order_id}", "get", []string{"200", "401", "404"}},
		{"/v1/trackings/{order_id}/status", "put", []string{"200", "400", "401", "404"}},
		{"/v1/trackings/by-user", "delete", []string{"200", "401", "422", "500"}},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			op := paths[tc.path].(map[string]any)[tc.method].(map[string]any)
			responses, _ := op["responses"].(map[string]any)
			for _, code := range tc.codes {
				if _, ok := responses[code]; !ok {
					t.Errorf("%s is not declared", code)
				}
			}
		})
	}
}

func TestDiffAgainstThePythonSpecIsEmptyExceptTheAllowlist(t *testing.T) {
	got := openapi.BuildSpec()
	want := loadYAML(t, pythonSpecPath)

	diffs := openapi.Diff(got, want)
	if len(diffs) != 0 {
		for _, d := range diffs {
			t.Errorf("unallowed difference at %s:\n  go:     %v\n  python: %v", d.Path, d.Got, d.Want)
		}
		t.Fatalf("%d differences outside the allowlist — the criterion is an EMPTY "+
			"diff except the enumerated list", len(diffs))
	}
}

func TestTheAllowlistIsClosedAndJustified(t *testing.T) {
	if len(openapi.AllowedDifferences) == 0 {
		t.Skip("no differences allowed yet")
	}
	seen := map[string]bool{}
	for _, a := range openapi.AllowedDifferences {
		if a.Justification == "" {
			t.Errorf("allowlist entry %q has no justification", a.Path)
		}
		if seen[a.Path] {
			t.Errorf("allowlist entry %q is duplicated", a.Path)
		}
		seen[a.Path] = true
	}
	// A growing allowlist is the signal that the criterion is no longer met.
	// Formatting details only; anything semantic belongs in the code, not here.
	const maxEntries = 12
	if len(openapi.AllowedDifferences) > maxEntries {
		t.Fatalf("the allowlist has %d entries — beyond formatting details, which "+
			"means the criterion is NOT met", len(openapi.AllowedDifferences))
	}
}

func TestTheNestedErrorBodiesAreAnAllowlistEntry(t *testing.T) {
	// The Python CODE emits {"detail": {"detail":…, "reason":…}} for the 404 and
	// 409 on init-tracking; the generated Python SPEC declares them flat because
	// FastAPI cannot express HTTPException's wrapping. The Go code matches the
	// CODE, so the spec difference must be recorded rather than "fixed".
	wantPaths := []string{
		"paths./v1/trackings/init-tracking.post.responses.404.content.application/json.schema",
		"paths./v1/trackings/init-tracking.post.responses.409.content.application/json.schema",
	}
	for _, p := range wantPaths {
		found := false
		for _, a := range openapi.AllowedDifferences {
			if a.Path == p {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%s is not in the allowlist — the Python spec is wrong here and "+
				"the Python code is right; the difference must be RECORDED", p)
		}
	}
}

// TestTheGoDocumentDeclaresTheNestedErrorSchema pins the OTHER half of the rule
// above. The allowlist entry alone would still pass if a future change made the
// Go handler emit the flat body "to match the spec": the difference would simply
// vanish, and an allowed difference that no longer occurs is silent. So this
// asserts the Go document POSITIVELY declares the nested shape.
func TestTheGoDocumentDeclaresTheNestedErrorSchema(t *testing.T) {
	spec := openapi.BuildSpec()
	op := spec["paths"].(map[string]any)["/v1/trackings/init-tracking"].(map[string]any)["post"].(map[string]any)
	responses := op["responses"].(map[string]any)

	for _, code := range []string{"404", "409"} {
		schema := responses[code].(map[string]any)["content"].(map[string]any)["application/json"].(map[string]any)["schema"].(map[string]any)
		if got := schema["$ref"]; got != "#/components/schemas/NestedErrorResponse" {
			t.Errorf("%s schema is %v, want the NESTED shape — the Python CODE wraps "+
				"the detail and the Go must too", code, got)
		}
	}

	nested := spec["components"].(map[string]any)["schemas"].(map[string]any)["NestedErrorResponse"].(map[string]any)
	inner, ok := nested["properties"].(map[string]any)["detail"].(map[string]any)
	if !ok {
		t.Fatal("NestedErrorResponse has no detail property")
	}
	if inner["$ref"] != "#/components/schemas/NestedErrorBody" {
		t.Errorf("NestedErrorResponse.detail is %v, want an OBJECT ref — a string "+
			"detail here is the flat shape wearing the nested name", inner)
	}
}

// TestNoResponseSchemaLeaksPIIOrIdentity walks every response schema the document
// declares. shipping_address is PII and cognito_sub is identity; neither appears
// on ANY response in the Python service, and a field added to a shared schema
// would leak on every route at once.
func TestNoResponseSchemaLeaksPIIOrIdentity(t *testing.T) {
	spec := openapi.BuildSpec()
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)

	forbidden := []string{"shipping_address", "cognito_sub"}
	// InitTrackingRequest and InternalDeleteByUserRequest are REQUEST bodies and
	// legitimately carry them; every response schema must not.
	requests := map[string]bool{
		"InitTrackingRequest":         true,
		"InternalDeleteByUserRequest": true,
		"UpdateStatusRequest":         true,
	}
	for name, raw := range schemas {
		if requests[name] {
			continue
		}
		schema, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		props, _ := schema["properties"].(map[string]any)
		for _, f := range forbidden {
			if _, present := props[f]; present {
				t.Errorf("response schema %s exposes %s", name, f)
			}
		}
	}
}

// TestDatetimeIsAStringOnEveryResponse pins the contract's least obvious field.
// It is a STRING (isoformat + "Z"), "" when absent — never RFC3339 and never
// null, so it must never be declared as a nullable or date-time-formatted field.
func TestDatetimeIsAStringOnEveryResponse(t *testing.T) {
	spec := openapi.BuildSpec()
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)

	for _, name := range []string{"TrackingResponse", "TrackingHistoryEntryResponse"} {
		props := schemas[name].(map[string]any)["properties"].(map[string]any)
		field, ok := props["datetime"].(map[string]any)
		if !ok {
			t.Fatalf("%s has no datetime property", name)
		}
		if field["type"] != "string" {
			t.Errorf("%s.datetime type is %v, want string", name, field["type"])
		}
		if _, hasFormat := field["format"]; hasFormat {
			t.Errorf("%s.datetime declares a format — it is a plain string, and "+
				"format: date-time would tell a consumer to expect RFC3339", name)
		}
		if _, nullable := field["anyOf"]; nullable {
			t.Errorf("%s.datetime is declared nullable — it is \"\" when absent, "+
				"never null", name)
		}
	}
}

// TestEveryAllowlistEntryIsActuallyUsED guards the OTHER failure mode of a closed
// list: an entry that no longer matches anything.
//
// A stale entry is worse than useless. It is a standing permission to differ at a
// path nobody is watching any more, so the day something DOES diverge there, the
// gate stays green and says nothing — and the justification beside it reads like
// a deliberate decision rather than the leftover it is. This test makes an entry
// that stopped mattering fail loudly, which is how the list stays a description of
// reality instead of a record of what used to be true.
func TestEveryAllowlistEntryIsActuallyUsed(t *testing.T) {
	got := openapi.BuildSpec()
	want := loadYAML(t, pythonSpecPath)

	saved := openapi.AllowedDifferences
	openapi.AllowedDifferences = nil
	raw := openapi.Diff(got, want)
	openapi.AllowedDifferences = saved

	for _, entry := range openapi.AllowedDifferences {
		used := false
		for _, d := range raw {
			if covers(entry.Path, d.Path) {
				used = true
				break
			}
		}
		if !used {
			t.Errorf("allowlist entry %q matches nothing in the current diff — a stale "+
				"entry is a standing permission to differ at a path nobody is watching",
				entry.Path)
		}
	}
}

// covers mirrors the matcher inside Diff: a "*" segment matches one segment, and a
// pattern covers everything below the node it names. Duplicated here rather than
// exported, because exporting it would invite production code to depend on the
// allowlist's matching rules.
func covers(pattern, path string) bool {
	p := strings.Split(pattern, ".")
	c := strings.Split(path, ".")
	if len(c) < len(p) {
		return false
	}
	for i, seg := range p {
		if seg != "*" && c[i] != seg {
			return false
		}
	}
	return true
}

// TestTheCommittedArtifactMatchesBuildSpec closes the gap between the function the
// other tests exercise and the FILE consumers import.
//
// Every test above reads BuildSpec(). None of them reads openapi.yaml, so without
// this one the committed artifact could be months stale — a route added, the
// generator never re-run — and the whole suite would stay green while the file
// people actually import described a service that no longer exists. Regenerating
// is `go run ./cmd/genopenapi`, and this test is what says so out loud when it was
// forgotten.
func TestTheCommittedArtifactMatchesBuildSpec(t *testing.T) {
	committed := loadYAML(t, "../../openapi.yaml")

	// The allowlist is deliberately NOT applied here. It records where the Go
	// differs from the PYTHON contract; the artifact and BuildSpec are two
	// serializations of the same Go document, so any difference at all means the
	// file is stale.
	saved := openapi.AllowedDifferences
	openapi.AllowedDifferences = nil
	defer func() { openapi.AllowedDifferences = saved }()

	diffs := openapi.Diff(committed, openapi.BuildSpec())
	for _, d := range diffs {
		t.Errorf("the committed openapi.yaml is stale at %s:\n  file: %v\n  code: %v",
			d.Path, d.Got, d.Want)
	}
	if len(diffs) != 0 {
		t.Fatal("run `go run ./cmd/genopenapi` and commit the result in the SAME change")
	}
}
