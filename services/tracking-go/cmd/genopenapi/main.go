// Command genopenapi writes services/tracking-go/openapi.yaml from the Go
// routes. Run it from the service directory: go run ./cmd/genopenapi
//
// CONTRACT: The output is a COMMITTED artifact. Re-run this and commit the
// result in the SAME change as any route, schema or status-code edit — the
// comparison test pins the document, so drift surfaces in CI rather than in a
// consumer's generated client.
//
// CONTRACT: Do NOT add an --output flag. BuildSpec reads and dials nothing, and
// generating the file somewhere the test does not look is the one way a
// committed artifact silently goes stale. See [[openapi-specs]]
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

	// CONTRACT: Marshal section by section, indent 2, block style. A Go map has
	// no order, so one call sorts alphabetically and buries `paths` under four
	// hundred lines of schemas. The comparison test parses trees and does not
	// care, but a committed artifact exists to be READ in a diff.
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

	// CONTRACT: 0644, not 0600. This is a committed contract file consumers
	// import; 0600 differs from every other tracked file and shows up as a
	// spurious mode change the first time anyone regenerates it. It holds no
	// secret — BuildSpec reads no environment and dials nothing.
	//
	//nolint:gosec // G306: a public contract artifact, deliberately world-readable.
	if err := os.WriteFile(out, body, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", out, err)
	}

	fmt.Println("wrote", out)
	return nil
}

// CONTRACT: Resolve the destination from THIS SOURCE FILE's location, never
// os.Getwd(). Invoking the command from the repo root or the service directory
// must write the same file; a working-directory path leaves the committed
// artifact untouched while the run looks successful.
func outputPath() (string, error) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("cannot locate the source file to derive the output path from")
	}
	// .../services/tracking-go/cmd/genopenapi/main.go -> .../services/tracking-go
	serviceRoot := filepath.Dir(filepath.Dir(filepath.Dir(thisFile)))
	return filepath.Join(serviceRoot, "openapi.yaml"), nil
}
