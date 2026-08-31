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

// THE DOMAIN PURITY GATE.
//
// # The rule
//
// internal/domain — and its audit subpackage — may import ONLY the Go standard
// library. No gin, no sqlc-generated package, no redis, no aws-sdk, no grpc, no
// otel, and not even net/http. The rule is stated in doc.go and in
// services/tracking-go/CLAUDE.md §3; this file is what MAKES it a rule rather
// than a convention someone has to uphold.
//
// # Why it needed a gate at all
//
// The rule currently holds, and held for the whole migration. That is exactly
// the situation in which a rule is most fragile: nothing is failing, so nobody
// is looking. The first agent to reach for a convenience import — a uuid
// package instead of crypto/rand, a validation library instead of a switch —
// breaks a load-bearing architectural property with a completely green suite,
// and the break is invisible in review because the diff shows one plausible
// import line and no test output changes at all.
//
// This migration hit FIVE instances of "correct code, absent wiring, no failing
// test" (see cmd/server/wiring_reachability_test.go). The lesson each time was
// the same: a rule nobody can forget beats a rule everyone must remember.
//
// # What is actually at stake, so a failure message can say it
//
// Purity is not tidiness and it is not taste. Three concrete properties depend
// on it, and each one degrades the moment a single third-party import lands:
//
//  1. Business rules that compile without a framework can be TESTED without
//     one. Every test in this package runs with no database, no HTTP server, no
//     AWS endpoint and no network — which is why they are fast enough that
//     nobody is tempted to skip them, and why they never flake.
//  2. The COMPILER is what makes the hexagonal boundary real. Ports are
//     declared by their consumers precisely so the dependency arrow points
//     inward; an import in domain reverses that arrow, and no amount of
//     documentation stops the next one.
//  3. A dependency in domain becomes a dependency of EVERYTHING, because every
//     other package imports domain. A CVE, a breaking major version or an
//     abandoned library then has to be dealt with in the one package that
//     should have been able to outlive all three.
//
// # Why `go list -deps -json`, and not go/build or an AST walk
//
// Three implementations were available. The choice matters because a gate that
// under-reports is worse than no gate — it converts "nobody checked" into
// "something checked and said fine".
//
//   - AST parsing (go/parser over the .go files) reads the import lines this
//     package writes and nothing further. It is dependency-free and fast, but it
//     sees only DIRECT imports. A domain file importing a module-local helper
//     package that itself imports gin would pass — the arrow still got reversed,
//     just one hop away. Rejected: the property being defended is transitive.
//   - go/build resolves imports through the build context and can be walked
//     transitively by hand, but the walk has to be written and maintained here,
//     it needs build-tag and vendor handling to be correct, and it duplicates
//     logic the toolchain already owns.
//   - `go list -deps -json` returns the FULL transitive closure with a
//     `Standard` boolean per package, computed by the same toolchain that
//     compiles the code. There is no heuristic to get wrong, and the result is
//     the truth by construction.
//
// The last one wins, and this file follows the precedent already set by
// cmd/server/wiring_reachability_test.go, which shells out to `go list` for the
// same reason: the alternative there was adding golang.org/x/tools to the
// module, and paying a production dependency for a test helper is the wrong
// trade.
//
// # The `Standard` field is the whole reason to prefer -json
//
// The obvious shell version of this check, and the one CLAUDE.md documents as a
// manual command, is:
//
//	go list -deps ./internal/domain/... | grep -v '^github.com/...' | grep '\.'
//
// It classifies by "does the import path contain a dot", the usual proxy for a
// module path. On Go 1.26.7 that proxy is WRONG here — verified, not assumed:
// the closure contains `crypto/internal/entropy/v1.0.0`, a stdlib package whose
// path contains dots, so the shell one-liner reports a violation on a pure
// domain. Classifying by the toolchain's own `Standard` flag has no such
// failure mode, in either direction.
//
// # Handling the toolchain not being on PATH
//
// A test that shells out has to survive `go` being absent from the test
// process's PATH, which under goenv it frequently is: the shim directory is on
// the developer's PATH but not necessarily exported into the test binary's
// environment. goToolPath() below anchors on $GOROOT, which `go test` sets for
// the process it launches. If that fails too, `go list` errors and this gate
// FAILS — it never skips. A purity gate that skipped when it could not run
// would be indistinguishable from a purity gate that passed, which is the exact
// failure shape this file exists to eliminate.

// domainPackages are the packages the purity rule covers.
//
// Listed explicitly rather than globbed, so adding a subpackage under
// internal/domain is a deliberate act that also decides whether the rule
// applies to it. `./internal/domain/...` would cover a new subpackage silently,
// which sounds better until the day someone adds internal/domain/httpx and the
// gate quietly starts defending a package that was never meant to be pure.
var domainPackages = []string{
	"./internal/domain",
	"./internal/domain/audit",
}

// TestDomainImportsOnlyTheStandardLibrary is the gate.
func TestDomainImportsOnlyTheStandardLibrary(t *testing.T) {
	pkgs := listDeps(t, domainPackages...)

	// Two different facts, reported differently — measured during the mutation
	// that proved this gate: a SINGLE `import "github.com/gin-gonic/gin"` in
	// status.go pulled 100 non-stdlib packages into the closure. Dumping all
	// 100 buries the one line a developer has to delete under 99 they have
	// never heard of, so:
	//
	//   - DIRECT violations (imported by a domain package itself) lead the
	//     report. That is the edit to revert, and it is usually exactly one.
	//   - The transitive total is reported as a COUNT, because its size is the
	//     argument for the rule, not a list anybody needs to read.
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
		// No DIRECT import means the violation arrived through a MODULE-LOCAL
		// hop: a domain package imports some internal/... helper that is itself
		// impure. This is the case a direct-imports-only gate (an AST walk over
		// the domain's own import lines) would pass, and it is why this gate
		// uses the transitive closure — verified by mutation, not assumed.
		//
		// Printing "no direct import" and stopping would leave the developer
		// with 100 package names and no thread to pull, so trace the shortest
		// path from a domain package to one violation instead.
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
// Every failure mode of this gate that matters ends in "found nothing to
// check": go list returning an empty set, a renamed package path, a filter that
// excludes everything. In each case the gate above passes with a green tick and
// has proven precisely nothing — the same shape as the eleven silently skipped
// repository tests documented in CLAUDE.md §6.
//
// So this test asserts the gate had real input: the closure must contain the
// domain packages themselves and a plausible number of stdlib packages.
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
// Standard is the toolchain's own answer to "is this the standard library",
// which is the entire reason for -json: see the note above about
// crypto/internal/entropy/v1.0.0 defeating the dot heuristic.
type listedPackage struct {
	ImportPath string
	Standard   bool
	Imports    []string
}

// listDeps returns the full transitive dependency closure of the given patterns.
//
// It FAILS rather than skips when the toolchain cannot be run. A gate that
// skips when it cannot do its job reports the same green as a gate that ran and
// found nothing wrong, and the difference is exactly what matters.
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
// Only the domain packages, deliberately: a violation's transitive importers
// are third-party packages importing each other, which a developer here can
// neither see nor change. The actionable fact is always "which file in
// internal/domain wrote this import line", and this returns exactly that set.
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
// A breadth-first walk, so the chain returned is the shortest one and therefore
// the one with the fewest links a developer has to reason about. Only ONE chain
// is reported: with a transitive violation the chains all share their first
// module-local hop, and that hop is the edit to revert.
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
// Not a bare "go": `go test` does not guarantee the toolchain is on PATH, and
// under goenv (which this repo pins with) it frequently is not — the shim
// directory is on the developer's PATH but not necessarily on the test
// process's. GOROOT is the reliable anchor and `go test` exports it into the
// test process's environment. runtime.GOROOT() would be the obvious call and is
// DEPRECATED as of Go 1.24 (it reports the root used at BUILD time, meaningless
// if the binary moved); the environment variable is what that notice points to.
//
// Same helper, same reasoning, as cmd/server/wiring_reachability_test.go. It is
// duplicated rather than shared because the two live in different packages and
// a test-only helper package would be a new import surface for eleven lines.
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
