package mysql_test

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

const (
	schemaAdminDSNEnv     = "TRACKING_TEST_MYSQL_ADMIN_DSN"
	schemaAdminDefaultDSN = "root:test@tcp(127.0.0.1:7002)/"
	trackingTestMySQLDSN  = "TRACKING_TEST_MYSQL_DSN"
)

// schemaAdminDSN returns a server-level DSN (no database segment) for DDL the
// local `test` user cannot run. Floci grants `test` only database-scoped
// privileges on `orders` and `tracking`, not CREATE/DROP DATABASE ON *.* — the
// same constraint documented in infra/environments/local/scripts/create_mysql_database.py.
// Root is root:test through the RDS proxy, matching infra provisioning scripts.
func schemaAdminDSN(appServerDSN string) string {
	if v := strings.TrimSpace(os.Getenv(schemaAdminDSNEnv)); v != "" {
		return v
	}
	if appServerDSN != "" {
		return withRootCredentials(appServerDSN)
	}
	if v := strings.TrimSpace(os.Getenv(trackingTestMySQLDSN)); v != "" {
		return withRootCredentials(v)
	}
	return schemaAdminDefaultDSN
}

func withRootCredentials(serverDSN string) string {
	at := strings.Index(serverDSN, "@")
	if at < 0 {
		return schemaAdminDefaultDSN
	}
	return "root:test" + serverDSN[at:]
}

func appUserFromServerDSN(serverDSN string) string {
	at := strings.Index(serverDSN, "@")
	if at <= 0 {
		return "test"
	}
	user, _, found := strings.Cut(serverDSN[:at], ":")
	if !found || user == "" {
		return "test"
	}
	return user
}

// openSchemaAdmin opens a root connection for throwaway-schema DDL.
func openSchemaAdmin(t *testing.T, appServerDSN string) *sql.DB {
	t.Helper()
	admin, err := sql.Open("mysql", schemaAdminDSN(appServerDSN)+"?parseTime=true&multiStatements=true")
	if err != nil {
		t.Fatalf("open mysql admin: %v", err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := admin.PingContext(ctx); err != nil {
		_ = admin.Close()
		t.Fatalf("ping mysql admin: %v", err)
	}
	return admin
}

func grantSchemaToAppUser(t *testing.T, admin *sql.DB, schema, appUser string) {
	t.Helper()
	_, err := admin.ExecContext(t.Context(), fmt.Sprintf(
		"GRANT ALL PRIVILEGES ON `%s`.* TO '%s'@'%%'; FLUSH PRIVILEGES;", schema, appUser))
	if err != nil {
		t.Fatalf("granting test schema to %q: %v", appUser, err)
	}
}

// requireThrowawaySchema creates an isolated database for one test suite.
// DDL runs as root; queries run as the app user from appServerDSN.
func requireThrowawaySchema(t *testing.T, appServerDSN, schema string) *sql.DB {
	t.Helper()

	admin := openSchemaAdmin(t, appServerDSN)
	appUser := appUserFromServerDSN(appServerDSN)

	if _, err := admin.ExecContext(t.Context(), "DROP DATABASE IF EXISTS "+schema); err != nil {
		_ = admin.Close()
		t.Fatalf("dropping a stale test schema: %v", err)
	}
	if _, err := admin.ExecContext(t.Context(),
		"CREATE DATABASE "+schema+" DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"); err != nil {
		_ = admin.Close()
		t.Fatalf("creating the test schema: %v", err)
	}
	grantSchemaToAppUser(t, admin, schema, appUser)

	t.Cleanup(func() {
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer dropCancel()
		_, _ = admin.ExecContext(dropCtx, "DROP DATABASE IF EXISTS "+schema)
		_ = admin.Close()
	})

	db, err := sql.Open("mysql", appServerDSN+schema+"?parseTime=true&multiStatements=true")
	if err != nil {
		t.Fatalf("opening the test schema: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}
