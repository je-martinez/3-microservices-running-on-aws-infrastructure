package mysql_test

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

// THE SILENT-SKIP GATE.
//
// # The hollow green this file exists to prevent
//
// Without a database configured, every real-MySQL test in this package calls
// t.Skip and the package prints:
//
//	ok  	.../internal/adapter/mysql	0.285s
//
// Measured, not assumed: with no database reachable, FOURTEEN tests skip and
// the suite still reports ok across every package. Somebody reading that output
// would reasonably conclude the suite passed. It did not — it declined to run
// the tests that guard the most expensive bugs in this service:
//
//   - ownership scoping by cognito_sub (CLAUDE.md §7 — the bug that answered
//     404 to every rightful owner, including on their own trackings, while
//     looking correctly implemented),
//   - soft delete by user and by tag (routes 6 and 7, the widest blast radius
//     this service has),
//   - transactional ROLLBACK of the two-row create,
//   - the 1062 duplicate-key translation that makes creation idempotent,
//   - the scoped-vs-unscoped distinction that a Go zero value makes so easy to
//     get backwards.
//
// None of those can be covered by a mock. That is a documented repo-wide
// lesson: only the server produces error 1062, only the server rounds a
// DATETIME at fsp 0, only the server evaluates JSON_CONTAINS. A mocked test
// passes while the real schema rejects the write.
//
// This already caused a hollow green during Wave 3A of the migration: "16
// packages ok" concealed all of them.
//
// # Why FAIL rather than a loud SKIP — the design decision
//
// Three options were on the table.
//
//  1. A SUMMARY LINE naming what was skipped. Rejected as the primary
//     mechanism: it changes the output but not the EXIT CODE. CI is green, the
//     PR is mergeable, and the line scrolls past above a wall of `ok`. It
//     informs a reader who is already paying attention — which is precisely the
//     reader who did not need it.
//  2. A MAKE TARGET that sets the DSN. Necessary, and added (see `make
//     test-db`), but not sufficient on its own: it makes the right thing easy
//     without making the wrong thing loud, and the wrong thing here is the
//     DEFAULT — a bare `go test ./...`, which is what an agent or a CI job
//     reaches for first.
//  3. FAIL when the database is absent, unless skipping is an explicit,
//     recorded choice. Chosen. It inverts the default: the suite's honest
//     answer to "did everything pass?" becomes no unless the eleven-plus
//     database tests actually ran. Skipping remains possible — it must, since
//     not every machine has Floci up — but it becomes a DELIBERATE ACT that
//     leaves a trace in the command line, rather than the silent default.
//
// The escape hatch is TRACKING_SKIP_DB_TESTS=1. It is deliberately not a
// value anyone sets by accident, and when it IS set this gate still prints the
// full inventory of what went unverified, so even the opted-out run cannot be
// mistaken for a full pass.
//
// # Why TestMain and not an ordinary test
//
// An ordinary test can assert the environment is configured, but it runs
// alongside the others and says nothing about the RESULT of the run. TestMain
// wraps m.Run(), so it can inspect the outcome and — critically — OVERRIDE THE
// EXIT CODE. The exit code is the only part of a test run that CI, a Makefile,
// and an agent all actually read.
//
// # KNOWN LIMITATION, measured rather than reasoned about
//
// `go test` BUFFERS AND DISCARDS a passing package's stdout and stderr unless
// -v is passed. Verified directly against this gate:
//
//	grep -c "DATABASE TESTS WERE SKIPPED"  ->  1 with -v, 0 without it
//
// So on the OPT-OUT path — which exits 0 by design — the inventory below is
// invisible in a default `go test ./...`. The only output channel Go surfaces
// reliably without -v is a FAILURE, and failing is precisely what the opt-out
// exists not to do; the two cannot both be had from inside a test binary.
//
// This matters because it is the same shape as the bug being fixed: an
// opted-out run that LOOKS like a full pass. The mitigation is therefore
// outside the test binary, where output is never buffered — `make test-no-db`
// prints a short always-visible banner of its own, and this file keeps the
// detailed inventory for -v runs.
//
// The FAILING path has no such limitation: a failing package's output is always
// shown, so the run that actually needs the inventory always gets it.

// dbDSNEnv and dbServerDSNEnv are the two variables this package's tests read.
//
// TWO variables, not one, and that split is itself a hazard worth naming: the
// creation/reads/transition suites read TRACKING_DATABASE_URL (a full mysql://
// URL, database segment included), while the count and soft-delete suites read
// TRACKING_TEST_MYSQL_DSN (a Go driver DSN with NO database segment, since they
// each create a throwaway schema). Setting only one leaves the other group
// skipping — the exact split that made the documented skip list read as
// "eleven tests" when a database-less run actually skips fourteen.
//
// This gate therefore checks BOTH, and reports which one is missing.
const (
	dbDSNEnv       = "TRACKING_DATABASE_URL"
	dbServerDSNEnv = "TRACKING_TEST_MYSQL_DSN"
	dbOptOutEnv    = "TRACKING_SKIP_DB_TESTS"
)

// guardedByTheDatabase is the inventory of what a database-less run does not
// verify, and why each entry is expensive.
//
// It is a hand-maintained list rather than a computed one on purpose: the point
// is not to count skips, it is to tell a reader WHAT COVERAGE THEY DO NOT HAVE.
// A generated list of test names ("TestScopedReadsFilterByCognitoSub skipped")
// names the symbol; this names the bug.
//
// When you add a real-MySQL test here whose subject is not already covered by a
// line below, add a line. When you delete one, delete its line.
var guardedByTheDatabase = []string{
	"ownership scoping by cognito_sub — the bug that answered 404 to every rightful owner while looking correct",
	"scoped vs unscoped reads — separate methods, because Go's zero value for string is \"\" and not nil",
	"soft delete by user id OR cognito_sub — the account-deletion cascade (route 6)",
	"soft delete by tag — the E2E teardown (route 7), and that an untagged row is untouchable",
	"transactional rollback: a failed history row must leave NO tracking row behind",
	"the 1062 duplicate-key translation that makes creation idempotent (409, not 500)",
	"MySQL DATETIME at fsp 0 ROUNDING a fractional second forward and inverting an ordering",
	"JSON_CONTAINS tag matching, and a tag literal staying a bound parameter",
	"scanning a NULL shipping_address into []byte (json.RawMessage fails at runtime)",
	"CASE-SENSITIVE identity comparison under the baseline's declared collation",
	"status counting for the metrics ticker, excluding soft-deleted rows",
}

// TestMain fails the package when the database tests did not run.
func TestMain(m *testing.M) {
	code := m.Run()

	// A real failure is already loud and already correct: do not overwrite a
	// non-zero exit with this gate's own. The gate exists to turn a FALSE green
	// into a red, never to editorialise on a red that is already true.
	if code != 0 {
		os.Exit(code)
	}

	configured, missing := databaseConfiguration()
	if configured {
		os.Exit(code)
	}

	optedOut := strings.TrimSpace(os.Getenv(dbOptOutEnv)) == "1"

	// The inventory prints in BOTH branches. An opted-out run is a legitimate
	// choice, but it is still a run in which none of the below was verified,
	// and the person reading the output — or the agent about to report "tests
	// pass" — needs that fact in front of them either way.
	fmt.Fprint(os.Stderr, skipReport(missing, optedOut))

	if optedOut {
		os.Exit(code)
	}
	os.Exit(1)
}

// databaseConfiguration reports whether BOTH DSN variables are set, and which
// are not.
//
// Both, not either: the two groups of tests in this package read different
// variables, so a run with only one set still silently skips the other group —
// and "some of the database tests ran" is the same hollow green in a smaller
// package.
func databaseConfiguration() (configured bool, missing []string) {
	for _, name := range []string{dbDSNEnv, dbServerDSNEnv} {
		if strings.TrimSpace(os.Getenv(name)) == "" {
			missing = append(missing, name)
		}
	}
	return len(missing) == 0, missing
}

// skipReport renders the failure (or the opted-out warning).
func skipReport(missing []string, optedOut bool) string {
	var b strings.Builder

	b.WriteString("\n" + strings.Repeat("=", 78) + "\n")
	if optedOut {
		b.WriteString("DATABASE TESTS WERE SKIPPED — " + dbOptOutEnv + "=1 (this is NOT a full pass)\n")
	} else {
		b.WriteString("FAILED: the real-MySQL tests in internal/adapter/mysql DID NOT RUN\n")
	}
	b.WriteString(strings.Repeat("=", 78) + "\n\n")

	fmt.Fprintf(&b, "Unset: %s\n\n", strings.Join(missing, ", "))

	b.WriteString("The suite would otherwise have printed `ok` for this package while silently\n")
	b.WriteString("skipping every test below. NONE of this is currently verified:\n\n")
	for _, item := range guardedByTheDatabase {
		fmt.Fprintf(&b, "  - %s\n", item)
	}

	b.WriteString("\nNone of it can be covered by a mock: only the server produces error 1062,\n")
	b.WriteString("rounds a DATETIME at fsp 0, or evaluates JSON_CONTAINS. A mocked test passes\n")
	b.WriteString("while the real schema rejects the write.\n\n")

	if optedOut {
		b.WriteString("Exiting 0 because you asked to skip. Do not report this run as a full pass.\n")
		b.WriteString(strings.Repeat("=", 78) + "\n\n")
		return b.String()
	}

	b.WriteString("TO RUN THEM (the port is NOT fixed — Floci reassigns RDS proxy ports on\n")
	b.WriteString("every apply, so it is discovered, never hardcoded):\n\n")
	b.WriteString("    cd services/tracking-go && make test-db\n\n")
	b.WriteString("That target reads the generated .env.local.tracking-go, rewrites the compose\n")
	b.WriteString("hostname to 127.0.0.1, and sets both variables. `make test-db-env` prints what\n")
	b.WriteString("it discovered without running anything.\n\n")

	b.WriteString("TO SKIP THEM DELIBERATELY (no database on this machine):\n\n")
	fmt.Fprintf(&b, "    %s=1 make test\n\n", dbOptOutEnv)
	b.WriteString("Skipping stays possible on purpose — but as a recorded choice on the command\n")
	b.WriteString("line, not as the silent default. A run nobody chose to skip must not be able\n")
	b.WriteString("to look like a run in which everything passed.\n")
	b.WriteString(strings.Repeat("=", 78) + "\n\n")

	return b.String()
}
