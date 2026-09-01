package mysql_test

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

// CONTRACT: Do NOT let the real-MySQL suites skip implicitly. Without both DSNs,
// fourteen tests covering ownership, deletion, transactions, and MySQL semantics
// disappear behind package `ok`. TRACKING_SKIP_DB_TESTS=1 is the explicit escape.
// See [[testing]]

// dbDSNEnv and dbServerDSNEnv are the two variables this package's tests read.
// CONTRACT: Do NOT treat either DSN as sufficient; setting only one silently
// skips the other database-test group.
// See [[testing]]
const (
	dbDSNEnv       = "TRACKING_DATABASE_URL"
	dbServerDSNEnv = "TRACKING_TEST_MYSQL_DSN"
	dbOptOutEnv    = "TRACKING_SKIP_DB_TESTS"
)

// guardedByTheDatabase is the inventory of what a database-less run does not
// verify, and why each entry is expensive.
//
// CONTRACT: Keep this semantic inventory aligned with real-MySQL coverage.
// A generated test-name list would hide which production failures went untested.
// See [[testing]]
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
// CONTRACT: Require both variables; either missing DSN leaves a database-test
// group silently skipped.
// See [[testing]]
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
