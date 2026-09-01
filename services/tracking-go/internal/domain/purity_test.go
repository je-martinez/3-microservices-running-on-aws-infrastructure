package domain_test

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// CONTRACT: Do NOT import non-stdlib packages into internal/domain or audit,
// directly or transitively. Framework dependencies reverse the hexagonal arrow
// and make isolated domain tests require adapters. Use `go list -deps -json`;
// AST checks miss transitive imports, and an unavailable toolchain fails closed.
// See [[ADR-0021-tracking-go-gin-sqlc-stack]]

// domainPackages are the packages the purity rule covers.
// CONTRACT: Do NOT replace this explicit inventory with a glob. A new domain
// subpackage would enter the boundary without review.
// See [[ADR-0021-tracking-go-gin-sqlc-stack]]
var domainPackages = []string{
	"./internal/domain",
	"./internal/domain/audit",
}

// TestDomainImportsOnlyTheStandardLibrary is the gate.
func TestDomainImportsOnlyTheStandardLibrary(t *testing.T) {
	pkgs := listDeps(t, domainPackages...)

	// WHY: Lead with actionable direct imports and report the transitive closure
	// as a count; listing every indirect dependency buries the offending edit.
	var direct []string
	total := 0
	for _, p := range pkgs {
		if p.Standard || strings.HasPrefix(p.ImportPath, modulePath) {
			continue
		}
		total++
		if importers := domainImportersOf(pkgs, p.ImportPath); len(importers) > 0 {
			direct = append(direct, fmt.Sprintf("  %s\n      imported directly by: %s",
				p.ImportPath, strings.Join(importers, ", ")))
		}
	}

	if total == 0 {
		return
	}
	sort.Strings(direct)

	report := strings.Join(direct, "\n")
	if len(direct) == 0 {
		// WHY: A missing direct importer means impurity entered through a
		// module-local helper; the shortest path identifies the first editable hop.
		report = "  (no DIRECT import — the violation arrives through a module-local package)\n" +
			shortestPathReport(pkgs)
	}

	t.Fatalf(`internal/domain is NO LONGER PURE.

%d non-stdlib package(s) are now reachable from it, pulled in by %d direct import(s):

%s

That ratio is the point: one convenience import is never one dependency.

internal/domain and internal/domain/audit may import ONLY the Go standard library.

WHY THIS MATTERS — the three properties this breaks:

  1. Business rules that compile without a framework can be TESTED without one.
     Every test in this package runs with no database, no HTTP server, no AWS
     endpoint and no network. That is why they are fast and never flake, and it
     stops being true the moment domain needs something started to be exercised.

  2. THE COMPILER is what makes the hexagonal boundary real. Ports are declared
     by their consumers so the dependency arrow points inward, toward the
     domain. An import here reverses that arrow, and once reversed no amount of
     documentation stops the next one — the boundary becomes a convention
     someone has to remember rather than a property the build enforces.

  3. A dependency here is a dependency of EVERYTHING, because every other
     package imports domain. A CVE, a breaking major version or an abandoned
     library then has to be handled in the one package that should have been
     able to outlive all three.

WHAT TO DO INSTEAD: whatever the import offered, the domain needs as an
INTERFACE it declares and an adapter implements — that is the ports pattern this
service already uses everywhere else. If the import was a convenience (an id
generator, a validator, a time helper), the stdlib equivalent or twenty lines
here is the cheaper long-term trade.

If you believe this rule should change, that is an architectural decision and
belongs in an ADR, not in an edit to this test.`,
		total, len(direct), report)
}

// TestPurityGateActuallyInspectsSomething is the anti-vacuous-pass guard.
//
// CONTRACT: Do NOT remove this non-empty-input check. An empty or misdirected
// dependency closure makes the purity gate pass without inspecting the domain.
// See [[testing]]
func TestPurityGateActuallyInspectsSomething(t *testing.T) {
	pkgs := listDeps(t, domainPackages...)

	found := map[string]bool{}
	stdlib := 0
	for _, p := range pkgs {
		found[p.ImportPath] = true
		if p.Standard {
			stdlib++
		}
	}

	for _, want := range []string{
		modulePath + "/internal/domain",
		modulePath + "/internal/domain/audit",
	} {
		if !found[want] {
			t.Errorf("the dependency closure does not contain %s, so the purity gate "+
				"is inspecting the wrong package set and would pass vacuously. "+
				"Did a package move or get renamed without updating domainPackages?", want)
		}
	}

	// The real closure is ~90 packages on Go 1.26.7 (runtime, errors, strconv,
	// crypto/rand and their internals). A floor of 10 cannot fail on a
	// toolchain upgrade trimming the graph, but does fail on an empty or
	// near-empty result.
	if stdlib < 10 {
		t.Errorf("only %d stdlib packages in the closure; expected the domain's real "+
			"transitive set. `go list -deps` probably failed to resolve the packages, "+
			"which would make the purity gate pass without inspecting anything.", stdlib)
	}
}

// listedPackage is the slice of `go list -json` this gate needs.
//
// WHY: Standard avoids path-based heuristics that misclassify stdlib imports.
type listedPackage struct {
	ImportPath string
	Standard   bool
	Imports    []string
}

// listDeps returns the full transitive dependency closure of the given patterns.
//
// CONTRACT: Do NOT skip when the toolchain cannot run. Skipping reports the same
// green result as a verified-clean dependency closure.
// See [[testing]]
func listDeps(t *testing.T, patterns ...string) []listedPackage {
	t.Helper()

	// CommandContext, not Command: t.Context() is cancelled when the test ends,
	// so a `go list` that wedges on a stale module-cache lock is killed with the
	// test rather than outliving it.
	args := append([]string{"list", "-deps", "-json"}, patterns...)
	// #nosec G204 -- the only non-literal arguments are the go binary's own path
	// (derived from $GOROOT, which `go test` sets for this process) and the
	// package patterns in domainPackages, which are constants in this file.
	// No external input reaches this command.
	cmd := exec.CommandContext(t.Context(), goToolPath(), args...)
	// `go test` runs a test binary with its cwd set to the PACKAGE directory
	// (internal/domain), so the module root is three levels up.
	cmd.Dir = filepath.Join("..", "..")
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("go list -deps failed, so domain purity could NOT be verified: %v\n%s\n\n"+
			"This is a failure and not a skip on purpose: an unverified purity rule and a "+
			"verified-clean one must never report the same colour.", err, stderr.String())
	}

	var pkgs []listedPackage
	dec := json.NewDecoder(strings.NewReader(string(out)))
	for dec.More() {
		var p listedPackage
		if err := dec.Decode(&p); err != nil {
			t.Fatalf("decoding go list output: %v", err)
		}
		pkgs = append(pkgs, p)
	}
	if len(pkgs) == 0 {
		t.Fatal("go list returned no packages; the purity gate would pass vacuously")
	}
	return pkgs
}

// domainImportersOf reports which DOMAIN packages import target directly.
//
// WHY: Only domain importers identify an actionable source edit; third-party
// transitive importers cannot be changed here.
func domainImportersOf(pkgs []listedPackage, target string) []string {
	var out []string
	for _, p := range pkgs {
		if !isDomainPackage(p.ImportPath) {
			continue
		}
		for _, imp := range p.Imports {
			if imp == target {
				out = append(out, strings.TrimPrefix(p.ImportPath, modulePath+"/"))
				break
			}
		}
	}
	sort.Strings(out)
	return out
}

// shortestPathReport traces the shortest import chain from a domain package to
// the first non-stdlib package it can reach, and renders it as
//
//	internal/domain -> internal/domain/helperx -> github.com/gin-gonic/gin
//
// WHY: Breadth-first traversal reports one shortest, actionable import chain.
func shortestPathReport(pkgs []listedPackage) string {
	imports := make(map[string][]string, len(pkgs))
	standard := make(map[string]bool, len(pkgs))
	for _, p := range pkgs {
		imports[p.ImportPath] = p.Imports
		standard[p.ImportPath] = p.Standard
	}

	// Deterministic start order, so the same violation always prints the same
	// chain and the failure is reproducible rather than map-order roulette.
	var queue []string
	for _, p := range domainPackages {
		queue = append(queue, modulePath+strings.TrimPrefix(p, "."))
	}
	prev := map[string]string{}
	seen := map[string]bool{}
	for _, q := range queue {
		seen[q] = true
	}

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]

		next := append([]string(nil), imports[cur]...)
		sort.Strings(next)
		for _, imp := range next {
			if seen[imp] {
				continue
			}
			seen[imp] = true
			prev[imp] = cur

			if !standard[imp] && !strings.HasPrefix(imp, modulePath) {
				// Found it: walk the parent links back to the domain root.
				chain := []string{imp}
				for at := cur; at != ""; at = prev[at] {
					chain = append(chain, strings.TrimPrefix(at, modulePath+"/"))
				}
				for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
					chain[i], chain[j] = chain[j], chain[i]
				}
				return "      shortest path: " + strings.Join(chain, " -> ")
			}
			// Only keep walking through module-local packages. A stdlib package
			// cannot lead anywhere impure, and following third-party imports
			// would report a chain nobody here can act on.
			if strings.HasPrefix(imp, modulePath) {
				queue = append(queue, imp)
			}
		}
	}
	return "      (no path found — inspect `go list -deps -json ./internal/domain/...` by hand)"
}

// isDomainPackage reports whether path is one of the packages the purity rule
// covers, derived from domainPackages so the two cannot drift.
func isDomainPackage(path string) bool {
	for _, p := range domainPackages {
		if modulePath+strings.TrimPrefix(p, ".") == path {
			return true
		}
	}
	return false
}

// goToolPath returns a usable path to the go binary.
//
// WHY: `go test` exports GOROOT but does not guarantee `go` is on PATH.
// Keep this helper local so the purity test gains no shared helper dependency.
func goToolPath() string {
	if goroot := os.Getenv("GOROOT"); goroot != "" {
		candidate := filepath.Join(goroot, "bin", "go")
		// #nosec G703 -- `candidate` is $GOROOT joined with a fixed literal, and
		// $GOROOT is set by the go tool that launched this test.
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	// Fall back to PATH resolution; if that fails, go list reports it and the
	// gate fails loudly rather than passing silently.
	return "go"
}

const modulePath = "github.com/jemartinez/3mrai/services/tracking-go"
