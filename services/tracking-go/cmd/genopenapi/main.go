// Command genopenapi writes services/tracking-go/openapi.yaml from the Go routes.
//
// # The output is a COMMITTED build artifact
//
// Like the Python's, and like the gRPC stubs next door: the file is checked in and
// regenerated deliberately. Any route, schema or status-code change must re-run
// this and commit the result in the SAME change, because internal/openapi's
// comparison test pins the document against the Python contract and the drift
// therefore surfaces in CI rather than in a consumer's generated client.
//
// # No database, no environment, no flags
//
// openapi.BuildSpec() reads nothing and dials nothing, so this command is a pure
// function of the source tree. It takes no arguments on purpose: an --output flag
// would make it possible to generate the file somewhere the test does not look,
// which is the one way a committed artifact silently goes stale.
//
// Run it from the service directory:
//
//	go run ./cmd/genopenapi
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/goccy/go-yaml"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/openapi"
)

// documentOrder is the top-level key order of the emitted file, mirroring the
// Python contract's. Not cosmetic in effect: it is what makes the two files
// diffable side by side when somebody is checking one against the other by eye.
var documentOrder = []string{"openapi", "info", "servers", "paths", "components", "tags"}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "genopenapi:", err)
		os.Exit(1)
	}
}

func run() error {
	out, err := outputPath()
	if err != nil {
		return err
	}

	// Marshalled section by section rather than in one call, so the file reads
	// openapi / info / servers / paths / components / tags top-down the way the
	// Python's does. A Go map has no order and the YAML encoder therefore sorts
	// alphabetically, which would put `components` first and bury `paths` in the
	// middle of four hundred lines of schemas. The comparison test parses both
	// documents into trees and does not care, but a committed artifact exists to
	// be READ in a diff, and that is decided entirely by this ordering.
	//
	// Indent 2 and block style throughout for the same reason: a spec with inline
	// {...} maps is one nobody can review a diff of.
	spec := openapi.BuildSpec()
	var body []byte
	for _, key := range documentOrder {
		value, ok := spec[key]
		if !ok {
			// Not skipped quietly: a top-level key BuildSpec emits and this list
			// does not name would be dropped from the artifact while every test
			// stayed green, since the tests read BuildSpec and not the file.
			continue
		}
		section, err := yaml.MarshalWithOptions(map[string]any{key: value}, yaml.Indent(2))
		if err != nil {
			return fmt.Errorf("marshal %s: %w", key, err)
		}
		body = append(body, section...)
	}
	if len(spec) != len(documentOrder) {
		return fmt.Errorf("BuildSpec has %d top-level keys and documentOrder names %d — "+
			"a key absent from the order would be silently dropped from the artifact",
			len(spec), len(documentOrder))
	}

	// 0644, not 0600. This is a committed, world-readable contract file that
	// consumers import and CI reads; generating it 0600 would produce a file whose
	// mode differs from every other tracked file in the repo, showing up as a
	// spurious mode change in git the first time anyone regenerates it. It holds
	// no secret: BuildSpec reads no environment and dials nothing.
	//
	//nolint:gosec // G306: a public contract artifact, deliberately world-readable.
	if err := os.WriteFile(out, body, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", out, err)
	}

	fmt.Println("wrote", out)
	return nil
}

// outputPath resolves the destination from THIS SOURCE FILE's location rather than
// from the working directory.
//
// `go run ./cmd/genopenapi` and `go run ./services/tracking-go/cmd/genopenapi` from
// the repo root must write the same file. Deriving it from os.Getwd() would put the
// artifact wherever the command happened to be invoked, leaving the committed one
// untouched and the run looking successful.
func outputPath() (string, error) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("cannot locate the source file to derive the output path from")
	}
	// .../services/tracking-go/cmd/genopenapi/main.go -> .../services/tracking-go
	serviceRoot := filepath.Dir(filepath.Dir(filepath.Dir(thisFile)))
	return filepath.Join(serviceRoot, "openapi.yaml"), nil
}
