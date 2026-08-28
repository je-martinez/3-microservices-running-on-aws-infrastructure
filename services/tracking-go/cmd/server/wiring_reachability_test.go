package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// THE WIRING GATE.
//
// # The bug this file exists to fail on
//
// Four times in this migration a component was written, unit-tested, reviewed,
// merged — and never called from the running process:
//
//  1. The route handlers existed; main.go registered none of them.
//  2. SetResolvedUserID existed; nothing called it, so the response cache never
//     engaged. Not for a TTL — always.
//  3. NewContextHandler and NewTraceHandler existed and were used only by their
//     own tests, so no log line in the running process carried request_id,
//     trace_id or any context field.
//  4. The cache gateway's metrics port was bound to the noop unconditionally, so
//     cache_requests_total and cache_operation_duration_ms were computed on every
//     request and discarded even with METRICS_ENABLED=true.
//
// Every unit test passed in all four cases, and that is not bad luck. Hexagonal
// architecture buys isolation by making every component constructible in
// isolation — which is exactly what lets a component be fully exercised by tests
// and reached by nothing.
//
// # Why an ORDINARY test cannot catch it, no matter how well written
//
// Because a test constructs its own subject. NewTraceHandler had a thorough,
// correct suite; it wrapped a handler by hand and asserted the output. That
// proves the component WORKS. It cannot, even in principle, prove that the
// PROCESS uses it — the test is itself a second caller, and its own call
// satisfies the assertion.
//
// The three earlier fixes each added a behavioural test ONE LEVEL BELOW the gap
// (logging_wiring_test.go tests newProcessLogger, not that run() calls it), so
// the same bug at the next seam up would still have shipped silently.
//
// # Why golangci-lint's `unused` cannot catch it either — verified, not assumed
//
// `unused` is ENABLED in .golangci.yml and reported zero issues against all four
// bugs. Probed directly against this module: a dead EXPORTED function is NOT
// flagged (only the unexported one beside it was), and an exported function
// referenced solely from a _test.go file is NOT flagged either, even with
// `run.tests: true`. That is deliberate on staticcheck's part — an exported
// symbol may have consumers outside the module. But in a hexagonal design EVERY
// seam crosses a package boundary and is therefore exported, which makes
// `unused` structurally blind to precisely this bug class.
//
// # What this test does instead
//
// It walks the static call graph from main() over the PRODUCTION package set and
// asserts that every seam in the inventory below is reached. "Is it wired?" is a
// different question from "does it work", and it is the one nothing else in this
// repo asks.
//
// # WHAT THIS GATE DOES NOT CATCH — measured by mutation, not assumed
//
// The walk asks "is this function MENTIONED anywhere reachable from main", not
// "is its return value actually installed". Those differ, and the difference was
// demonstrated rather than reasoned about: replacing
//
//	otelgin.Middleware(logging.ServiceName, otelgin.WithFilter(tracing.GinFilter))
//
// in the middleware chain with a no-op closure that still MENTIONS
// tracing.GinFilter leaves this gate GREEN, because the identifier is still
// there. The four behavioural tests in
// internal/adapter/http/tracing_middleware_test.go fail loudly on that same
// mutation.
//
// So the two layers divide the work, and neither replaces the other:
//
//   - THIS gate catches TOTAL absence — the symbol is reached from nowhere. That
//     is the shape all four historical bugs actually took, it costs one line per
//     seam, and it scales to every seam in the service.
//   - A BEHAVIOURAL test catches partial or subtly-wrong installation. It is far
//     more expensive to write, so it is worth it for the seams where "wired but
//     wrong" is a realistic failure — the middleware chain above all.
//
// The rule of thumb: every seam belongs in the inventory; a seam whose ORDER or
// OPTIONS matter also deserves a behavioural test beside it.
//
// # Dependencies: deliberately none
//
// The obvious implementation uses golang.org/x/tools/go/packages, but adding it
// to this module forces a downgrade of google.golang.org/grpc and golang.org/x/net.
// Paying that in the production dependency graph for a test helper is the wrong
// trade, so the package set comes from `go list -deps` (which is exactly the set
// linked into the binary) and the walk uses only go/ast and go/parser.

// wiringSeam is one component that MUST be reachable from main().
//
// `reason` is not documentation for its own sake: when this test fails, the
// reason is what tells the next person WHAT BREAKS IN PRODUCTION — the part a
// bare "X is not reachable" leaves them to rediscover.
type wiringSeam struct {
	pkg    string // full import path
	fn     string // function name
	reason string // what silently stops working when it is not wired
}

const (
	modulePath = "github.com/jemartinez/3mrai/services/tracking-go"

	pkgHTTP       = modulePath + "/internal/adapter/http"
	pkgOTel       = modulePath + "/internal/adapter/otel"
	pkgRedis      = modulePath + "/internal/adapter/redis"
	pkgCloudWatch = modulePath + "/internal/adapter/cloudwatch"
	pkgSQS        = modulePath + "/internal/adapter/sqs"
	pkgGRPCUsers  = modulePath + "/internal/adapter/grpcusers"
	pkgMySQL      = modulePath + "/internal/adapter/mysql"
	pkgApp        = modulePath + "/internal/app"
	pkgNotify     = modulePath + "/internal/adapter/notify"
	pkgLogging    = modulePath + "/internal/platform/logging"
	pkgConfig     = modulePath + "/internal/platform/config"
	pkgMain       = modulePath + "/cmd/server"
)

// requiredSeams is the INVENTORY: every component whose whole purpose is to be
// installed by the composition root.
//
// # What belongs here
//
// A seam is a component that is INERT UNLESS WIRED and whose failure to be wired
// is SILENT — the service still boots, still serves, still passes its tests, and
// simply stops doing one thing. That is the bug this gate catches. A pure
// function whose absence makes a handler fail to compile does NOT belong here;
// the compiler already guards it, and listing it only adds noise.
//
// # Adding to it
//
// When you add a middleware, an exporter, a background loop, or any other
// install-once component, add it here in the same commit. The cost is one line;
// the alternative is the fifth instance of a bug that has already cost this
// migration four debugging sessions.
var requiredSeams = []wiringSeam{
	// ── Observability: the whole category fails silently ────────────────────
	{pkgOTel, "SetupTracing", "no OTLP exporter is installed, so the service emits NO TRACES AT ALL while every span-opening call site still looks correct"},
	{pkgOTel, "NewTraceHandler", "bug #3: no log line in the running process carries trace_id or span_id, so logs and traces cannot be joined in OpenObserve"},
	{pkgLogging, "New", "the process logs unstructured text instead of the shared JSON schema, and no OpenObserve query can select on it"},
	{pkgMain, "installProcessLogger", "the enriched handler is built but never made the default, so any package logging through slog.Default emits bare records"},
	{pkgLogging, "ResolveRequestID", "requests carry no request_id, breaking cross-service correlation — and an attacker-supplied header would reach every log line unvalidated"},
	{pkgHTTP, "LogContextMiddleware", "bug #3: no request-scoped log context, so no line carries request_id, cognito_sub, user_id or duration_ms"},
	// GinFilter's ONLY purpose is to be handed to otelgin.WithFilter. It sat
	// defined, documented and referenced by nothing while otelgin was absent from
	// the middleware chain entirely — found by this audit's sweep as a
	// test-only symbol. Its presence here now pins the inbound instrumentation:
	// without otelgin there is no SERVER span, so workflow spans start as fresh
	// ROOTS and one request appears in OpenObserve as several unrelated traces.
	{pkgOTel, "GinFilter", "otelgin is not in the middleware chain: no inbound HTTP span exists, the caller's traceparent is dropped, and one flow renders as several disconnected traces"},
	{pkgMain, "poolTracingOptions", "the database pools are opened untraced, so no SQL span appears under any request — and the PII guard that disables query capture goes with it"},

	// ── Metrics ─────────────────────────────────────────────────────────────
	{pkgCloudWatch, "NewPublisher", "no custom metric is ever published; every 3MRAI dashboard panel for this service reads 'no data'"},
	{pkgCloudWatch, "StartTicker", "orders_by_tracking_status_total is never published and the status dashboards go flat"},
	{pkgMain, "selectCacheMetrics", "bug #4: the cache gateway's metrics port falls back to the noop, so cache_requests_total and cache_operation_duration_ms are computed on every request and discarded"},

	// ── Cache ───────────────────────────────────────────────────────────────
	{pkgRedis, "SelectGateway", "CACHE_ENABLED stops being a kill switch: either a Redis client is built while the cache is off, or the gateway is nil and the first read panics"},
	{pkgRedis, "NewIdentityCache", "every response-cache hit still pays a gRPC round trip to Users, defeating the point of the cache"},
	{pkgHTTP, "StampResolvedUserID", "bug #2: the read handlers cannot build a cache key without a usr_ id, so EVERY read is a miss forever while the code looks correct"},
	{pkgRedis, "NewUserInvalidator", "a deleted user's cached reads survive the deletion cascade and keep being served"},
	{pkgNotify, "NewTrackingCacheInvalidator", "a status change does not evict the cached tracking, so reads serve the previous status until the TTL expires"},

	// ── Routing and the request path ────────────────────────────────────────
	{pkgHTTP, "NewAppRouter", "bug #1: the process serves no routes at all"},
	{pkgHTTP, "RegisterHealth", "the ALB liveness probe 404s and the task is cycled forever"},
	{pkgHTTP, "RegisterInitTracking", "POST /v1/trackings/init-tracking 404s"},
	{pkgHTTP, "RegisterReads", "both user-facing reads 404"},
	{pkgHTTP, "RegisterCarrierRoutes", "the carrier webhook 404s and no delivery ever progresses"},
	{pkgHTTP, "RegisterInternalDelete", "the account-deletion cascade's tracking leg 404s and deleted users keep their delivery history"},
	{pkgHTTP, "E2ESourceMiddleware", "rows created by the E2E harness are not tagged, so e2e-cleanup silently deletes nothing"},
	{pkgHTTP, "TestModeMiddleware", "x-test-mode is ignored and the accelerated progression never runs"},

	// ── Outbound integrations ───────────────────────────────────────────────
	{pkgGRPCUsers, "Dial", "no Users client exists, so creation cannot resolve an internal usr_ id and every creation 404s"},
	{pkgSQS, "NewPublisher", "no tracking_status_changed event is ever emitted: the events-pipeline sends no email and pushes no WebSocket update"},
	{pkgNotify, "NewStatusEventPublisher", "status transitions are persisted but never announced, so the pipeline never hears about them"},
	{pkgApp, "NewProgression", "TestMode trackings never advance past PLACED"},

	// ── Persistence ─────────────────────────────────────────────────────────
	{pkgConfig, "MySQLDSN", "the SQLAlchemy DSN reaches the Go driver unconverted, or without parseTime/loc=UTC — every DATETIME comes back wrong or as []byte"},
	{pkgMySQL, "NewTrackingRepository", "creation has no writer and cannot persist"},
	{pkgMySQL, "NewTrackingReader", "the reads have no reader"},
	{pkgMySQL, "NewStatusRepository", "no status transition can be applied"},
	{pkgMySQL, "NewSoftDeleteRepository", "neither delete route can soft-delete anything"},
	{pkgMySQL, "NewMetricsRepository", "the metrics ticker has nothing to count"},
}

// TestEverySeamIsReachableFromMain is the gate.
func TestEverySeamIsReachableFromMain(t *testing.T) {
	graph := loadProductionGraph(t)
	reached := graph.reachableFrom(pkgMain + ".main")

	var missing []string
	for _, seam := range requiredSeams {
		key := seam.pkg + "." + seam.fn
		if reached[key] {
			continue
		}
		// Distinguish "declared but unreachable" from "does not exist": a seam
		// that was deleted outright must not read as a wiring bug, or the next
		// person chases a symbol that is gone.
		status := "NOT REACHABLE FROM main()"
		if !graph.declared[key] {
			status = "NOT DECLARED ANYWHERE (deleted or renamed?)"
		}
		missing = append(missing, fmt.Sprintf(
			"  %s.%s\n      %s\n      Consequence: %s",
			shortPkg(seam.pkg), seam.fn, status, seam.reason))
	}

	if len(missing) > 0 {
		sort.Strings(missing)
		t.Fatalf("%d declared seam(s) are NOT reached by the running process:\n\n%s\n\n"+
			"Each of these is inert in production while its own unit tests still pass —\n"+
			"the exact failure mode this gate exists to catch.\n"+
			"Either wire it into the composition root, or, if it is genuinely no longer\n"+
			"needed, delete it AND remove its entry from requiredSeams in this file.",
			len(missing), strings.Join(missing, "\n\n"))
	}
}

// TestEverySeamInTheInventoryExists keeps the inventory honest.
//
// Without this, a seam deleted from the codebase would keep an entry here
// forever, and the inventory would slowly become a list of things that no longer
// exist — which is how a gate stops being trusted and then stops being read.
func TestEverySeamInTheInventoryExists(t *testing.T) {
	graph := loadProductionGraph(t)

	for _, seam := range requiredSeams {
		key := seam.pkg + "." + seam.fn
		if !graph.declared[key] {
			t.Errorf("requiredSeams lists %s.%s, but no such function is declared in the production package set. "+
				"If it was renamed or removed, update the inventory in the same commit.",
				shortPkg(seam.pkg), seam.fn)
		}
	}
}

// callGraph is the production-only call graph.
type callGraph struct {
	// calls maps "importpath.Func" -> the module-local functions it mentions.
	calls map[string]map[string]bool
	// declared is the set of every function declared in the production packages.
	declared map[string]bool
}

// reachableFrom walks the graph from root and returns everything reached.
func (g *callGraph) reachableFrom(root string) map[string]bool {
	reached := map[string]bool{}
	stack := []string{root}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if reached[cur] {
			continue
		}
		reached[cur] = true
		for callee := range g.calls[cur] {
			if !reached[callee] {
				stack = append(stack, callee)
			}
		}
	}
	return reached
}

// goListPackage is the slice of `go list -json` this test needs.
type goListPackage struct {
	ImportPath string
	Dir        string
	GoFiles    []string
}

// loadProductionGraph builds the call graph over exactly the packages linked
// into the server binary.
//
// # `go list -deps ./cmd/server`, and why that specific set
//
// It is the transitive import closure of the MAIN PACKAGE — precisely what the
// linker puts in the binary, with no test variants. Using it means a call from a
// _test.go file cannot satisfy a seam, which is the whole point: the three
// earlier bugs were all "referenced only from tests", and a package set that
// included tests would have reported every one of them as correctly wired.
//
// # The walk is intentionally an OVER-APPROXIMATION
//
// Any identifier in a function body that matches a known function name counts as
// a call, without resolving types. That can only over-report reachability, never
// under-report it, so this gate cannot produce a FALSE ALARM that blocks a commit
// for no reason. The trade is that it could miss a subtle partial unwiring —
// but all four real bugs were TOTAL absences, where the symbol appeared nowhere
// in the reachable set, and those it catches exactly.
func loadProductionGraph(t *testing.T) *callGraph {
	t.Helper()

	// -deps from the MAIN package: no test variants, and internal/openapi is
	// excluded automatically because nothing in the binary imports it. (That
	// package is half-written by a parallel agent; the gate must not depend on
	// it building.)
	// CommandContext, not Command: t.Context() is cancelled when the test ends,
	// so a `go list` that wedges (a stale module cache lock, a network fetch)
	// is killed with the test instead of outliving it.
	//
	// #nosec G204 -- the only non-literal argument is the go binary's own path,
	// derived from $GOROOT, which `go test` sets for this very process. There is
	// no external input anywhere in this command.
	cmd := exec.CommandContext(t.Context(), goToolPath(), "list", "-deps", "-json", "./cmd/server")
	// `go test` runs a test binary with its cwd set to the PACKAGE directory
	// (cmd/server), so the module root is two levels up, not one.
	cmd.Dir = filepath.Join("..", "..")
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("go list -deps failed: %v\n%s", err, stderr.String())
	}

	var pkgs []goListPackage
	dec := json.NewDecoder(strings.NewReader(string(out)))
	for dec.More() {
		var p goListPackage
		if err := dec.Decode(&p); err != nil {
			t.Fatalf("decoding go list output: %v", err)
		}
		if strings.HasPrefix(p.ImportPath, modulePath) {
			pkgs = append(pkgs, p)
		}
	}
	if len(pkgs) == 0 {
		t.Fatal("go list returned no packages from this module; the gate would vacuously pass")
	}

	graph := &callGraph{
		calls:    map[string]map[string]bool{},
		declared: map[string]bool{},
	}

	// funcOwner maps a bare function name to the package(s) declaring it, so a
	// call site can be attributed without full type resolution.
	funcOwner := map[string][]string{}
	type parsedFunc struct {
		key  string
		body *ast.BlockStmt
		file *ast.File
		pkg  string
	}
	var parsed []parsedFunc

	fset := token.NewFileSet()
	for _, p := range pkgs {
		for _, name := range p.GoFiles {
			path := filepath.Join(p.Dir, name)
			f, err := parser.ParseFile(fset, path, nil, 0)
			if err != nil {
				t.Fatalf("parsing %s: %v", path, err)
			}
			for _, d := range f.Decls {
				fd, ok := d.(*ast.FuncDecl)
				if !ok || fd.Body == nil {
					continue
				}
				// Methods are keyed by name too: the inventory lists plain
				// constructors and registrars, and over-approximating here is
				// the safe direction.
				key := p.ImportPath + "." + fd.Name.Name
				graph.declared[key] = true
				funcOwner[fd.Name.Name] = appendUnique(funcOwner[fd.Name.Name], p.ImportPath)
				parsed = append(parsed, parsedFunc{key: key, body: fd.Body, file: f, pkg: p.ImportPath})
			}
		}
	}

	// importAlias resolves a file's selector qualifiers to import paths, so
	// `cache.SelectGateway` in main.go attributes to internal/adapter/redis
	// rather than to a package literally named "cache".
	for _, pf := range parsed {
		aliases := importAliases(pf.file)
		edges := map[string]bool{}

		ast.Inspect(pf.body, func(n ast.Node) bool {
			switch e := n.(type) {
			case *ast.SelectorExpr:
				// pkgAlias.Func — the cross-package case, which is every seam.
				if x, ok := e.X.(*ast.Ident); ok {
					if path, ok := aliases[x.Name]; ok {
						edges[path+"."+e.Sel.Name] = true
						return true
					}
				}
				// A method call: attribute by bare name to every declarer.
				for _, owner := range funcOwner[e.Sel.Name] {
					edges[owner+"."+e.Sel.Name] = true
				}
			case *ast.Ident:
				// A same-package call.
				if graph.declared[pf.pkg+"."+e.Name] {
					edges[pf.pkg+"."+e.Name] = true
				}
			}
			return true
		})

		if graph.calls[pf.key] == nil {
			graph.calls[pf.key] = map[string]bool{}
		}
		for k := range edges {
			graph.calls[pf.key][k] = true
		}
	}

	return graph
}

// importAliases maps the qualifier used in this file to the imported path.
// goToolPath returns a usable path to the go binary.
//
// Not a bare "go": `go test` does not guarantee the toolchain is on PATH, and
// under goenv (which this repo pins with) it frequently is not — the shim
// directory is on the developer's PATH but not necessarily on the test
// process's.
//
// GOROOT is the reliable anchor and `go test` exports it into the test
// process's environment, so read it from there. runtime.GOROOT() would be the
// obvious call and is DEPRECATED as of Go 1.24 (it reports the root used at
// BUILD time, which is meaningless if the binary moved); the environment
// variable is what the deprecation notice points to.
func goToolPath() string {
	if goroot := os.Getenv("GOROOT"); goroot != "" {
		candidate := filepath.Join(goroot, "bin", "go")
		// #nosec G703 -- `candidate` is $GOROOT joined with a fixed literal, and
		// $GOROOT is set by the go tool that launched this test, not by a caller.
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	// Fall back to PATH resolution; if that fails too, go list reports it and
	// the gate fails loudly rather than silently passing.
	return "go"
}

func importAliases(f *ast.File) map[string]string {
	out := map[string]string{}
	for _, imp := range f.Imports {
		path := strings.Trim(imp.Path.Value, `"`)
		if !strings.HasPrefix(path, modulePath) {
			continue
		}
		name := path[strings.LastIndex(path, "/")+1:]
		if imp.Name != nil {
			name = imp.Name.Name
		}
		out[name] = path
	}
	return out
}

func appendUnique(xs []string, v string) []string {
	for _, x := range xs {
		if x == v {
			return xs
		}
	}
	return append(xs, v)
}

func shortPkg(p string) string {
	return strings.TrimPrefix(p, modulePath+"/")
}
