package openapi_test

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/goccy/go-yaml"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/openapi"
)

// pythonSpecPath is a FROZEN SNAPSHOT of the contract served at the 2026-08-27
// cutover. It is evidence of a past state, not a second source of truth.
const pythonSpecPath = "testdata/python-contract-at-cutover.yaml"

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

// TestTheFrozenReferenceHasNotBeenEdited checksums the fixture's payload, which
// is what makes the whole frozen-reference arrangement safe.
//
// CONTRACT: Do NOT edit the fixture to make a failing equivalence gate go green.
// That edit reads as a small YAML fix in review while destroying the only
// evidence of the contract. Restore the bytes instead:
//
//	git show b889580^:services/tracking/openapi.yaml
//
// See [[openapi-specs]]
func TestTheFrozenReferenceHasNotBeenEdited(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(pythonSpecPath))
	if err != nil {
		t.Fatalf("read %s: %v", pythonSpecPath, err)
	}

	payload, ok := stripFixtureHeader(raw)
	if !ok {
		t.Fatalf("%s has no %q marker — the fixture header was mangled; restore the "+
			"file from `git show b889580^:services/tracking/openapi.yaml` and re-apply "+
			"the header", pythonSpecPath, fixtureMarker)
	}

	const wantSum = "d961351371a2fdc108692a2bd4b925bfe6e9730628713f28f377f50ddb35ea02"
	gotSum := fmt.Sprintf("%x", sha256.Sum256(payload))
	if gotSum != wantSum {
		t.Fatalf("the frozen reference has been EDITED.\n  got  sha256 %s\n  want sha256 %s\n"+
			"This file is evidence of the contract the Python service served at cutover; "+
			"editing it to match the Go document turns the equivalence gate into a mirror "+
			"of itself. Restore it with `git show b889580^:services/tracking/openapi.yaml`.",
			gotSum, wantSum)
	}
}

// fixtureMarker ends the explanatory header and begins the verbatim payload. The
// checksum covers only what follows it, so the header's prose can be improved
// without defeating the pin.
const fixtureMarker = "# Verbatim content of services/tracking/openapi.yaml @ b889580^ begins here.\n"

func stripFixtureHeader(raw []byte) ([]byte, bool) {
	_, after, found := strings.Cut(string(raw), fixtureMarker)
	if !found {
		return nil, false
	}
	// One more comment line ("# ---...") closes the box before the YAML starts.
	_, payload, found := strings.Cut(after, "\n")
	if !found {
		return nil, false
	}
	return []byte(payload), true
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

// TestDiffAgainstThePythonSpecIsEmptyExceptTheAllowlist asserts this service has
// not drifted from the contract it was accepted as equivalent to, in any way not
// enumerated and justified. It is NOT redundant with the route and failure
// tests: those assert a hand-written list somebody remembered, this asserts
// everything else against a reference nobody can quietly edit.
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

// TestTheGoDocumentDeclaresTheNestedErrorSchema pins the other half of the rule
// above: the allowlist entry alone still passes if a change makes the handler
// emit the flat body "to match the spec", because an allowed difference that
// stops occurring is silent. This asserts the nested shape POSITIVELY.
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

// TestEveryAllowlistEntryIsActuallyUsed guards the other failure mode of a
// closed list: a stale entry is a standing permission to differ at a path nobody
// watches, so the day something DOES diverge there the gate stays green while
// its justification reads like a deliberate decision.
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

// TestTheCommittedArtifactMatchesBuildSpec closes the gap between the function
// the other tests exercise and the FILE consumers import. Without it a route
// could be added and the generator never re-run, leaving the suite green while
// openapi.yaml describes a service that no longer exists. Regenerate with
// `go run ./cmd/genopenapi`.
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
