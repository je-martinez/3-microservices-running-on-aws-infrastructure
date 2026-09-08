// Package config reads and validates the process environment.
//
// CONTRACT: Exactly four variables are REQUIRED and Load errors on any missing
// one, so a misconfigured process refuses to start. Every other variable falls
// back to its default WITHOUT an error — a malformed optional value must never
// take a runtime down. See [[env-files]]
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config is the validated environment. Every field name here corresponds to a
// variable emitted by infra/environments/local/scripts/generate_env_files.py —
// renaming one is a change to that generator, not just to this struct.
type Config struct {
	// Database DSNs, in SQLAlchemy form. Convert with MySQLDSN before handing
	// either to database/sql. Reads go to the reader, writes to the writer
	// (ADR-0006); locally both point at the same Floci MySQL, but the split is
	// honoured in code so local and deployed behave identically.
	DatabaseWriterURL string
	DatabaseReaderURL string

	Port int

	// GRPCAPIKey is the INTERNAL service-to-service credential (ADR-0003),
	// shared with Users and Orders. TrackingCarrierAPIKey is the EXTERNAL key
	// handed to a third-party carrier. They are two fields because they are two
	// trust domains — see internal/adapter/http/auth.go.
	GRPCAPIKey            string
	TrackingCarrierAPIKey string

	// UsersGRPCURL may carry an http:// or https:// scheme: Orders' .NET channel
	// requires one, and both services read this same variable. The gRPC client
	// strips it.
	UsersGRPCURL string

	// EventsQueueURL is the one shared queue all three producers write to.
	// Defaults to empty; publishing fails (loudly, at the publisher) when it is.
	EventsQueueURL string

	// AWSEndpointURL is a pointer because "unset" is meaningful: locally it is
	// Floci, and in a deployed environment it must be absent so the SDK resolves
	// the real endpoint itself.
	AWSEndpointURL *string
	AWSRegion      string

	MetricsIntervalSeconds float64
	// ProgressionIntervalSeconds is TestMode's cadence: one transition per
	// interval across four transitions, so a delivery spec cannot finish sooner
	// than four intervals. Default 10s; local uses 5s.
	//
	// CONTRACT: Do NOT lower this below 5s. At 2s the four transitions publish
	// inside 8 seconds and the local emulator DROPS some before they reach the
	// queue — 21 published, 16 processed, empty DLQ, no consumer error. That is
	// an emulator limit; nothing here rate-limits the publish.
	// See [[testmode-in-process-no-durable-scheduler]]
	ProgressionIntervalSeconds float64
	// MetricsEnabled defaults TRUE: forgetting the variable in a deployed
	// environment must leave the dashboards populated, not silently empty.
	MetricsEnabled bool
	// E2ETestingEnabled defaults FALSE, the OPPOSITE direction and deliberately:
	// a runtime that never sets the variable must not serve the mass-delete
	// route at all.
	E2ETestingEnabled bool

	RedisHost string
	RedisPort int
	// CacheEnabled false means NO Redis client is constructed at all — see
	// internal/adapter/redis. The service then needs no reachable Redis to boot.
	CacheEnabled bool
	// CacheTimeoutMS is the budget for BOTH connect and socket. A connect that
	// takes longer than the operation is allowed to take has already blown it.
	CacheTimeoutMS int

	DeploymentEnvironment string
	// Environment is one of development, test, production. Any other value is a
	// startup error — unlike the optional flags, a typo here changes behaviour
	// silently (EchoSQL, and anything that branches on it later).
	Environment string
}

// EchoSQL reports whether to log SQL statements: everywhere except production.
func (c Config) EchoSQL() bool { return c.Environment != "production" }

const (
	defaultPort                   = 8000
	defaultUsersGRPCURL           = "users:50051"
	defaultAWSRegion              = "us-east-1"
	defaultMetricsIntervalSeconds = 15.0
	// The design cadence. See ProgressionIntervalSeconds.
	defaultProgressionIntervalSeconds = 10.0
	defaultRedisHost              = "localhost"
	defaultRedisPort              = 6379
	defaultCacheTimeoutMS         = 50
	defaultDeploymentEnvironment  = "local"
	defaultEnvironment            = "development"
)

var validEnvironments = map[string]bool{
	"development": true,
	"test":        true,
	"production":  true,
}

// Load reads the environment and validates it.
func Load() (Config, error) {
	cfg := Config{
		DatabaseWriterURL:      os.Getenv("DATABASE_WRITER_URL"),
		DatabaseReaderURL:      os.Getenv("DATABASE_READER_URL"),
		GRPCAPIKey:             os.Getenv("GRPC_API_KEY"),
		TrackingCarrierAPIKey:  os.Getenv("TRACKING_CARRIER_API_KEY"),
		Port:                   intInRange("PORT", defaultPort, 1, 65535),
		UsersGRPCURL:           stringOr("USERS_GRPC_URL", defaultUsersGRPCURL),
		EventsQueueURL:         os.Getenv("EVENTS_QUEUE_URL"),
		AWSEndpointURL:         optionalString("AWS_ENDPOINT_URL"),
		AWSRegion:              stringOr("AWS_REGION", defaultAWSRegion),
		MetricsIntervalSeconds: floatOr("METRICS_INTERVAL_SECONDS", defaultMetricsIntervalSeconds),
		ProgressionIntervalSeconds: floatOr("PROGRESSION_INTERVAL_SECONDS", defaultProgressionIntervalSeconds),
		MetricsEnabled:         Bool("METRICS_ENABLED", true),
		E2ETestingEnabled:      Bool("E2E_TESTING_ENABLED", false),
		RedisHost:              stringOr("REDIS_HOST", defaultRedisHost),
		RedisPort:              intInRange("REDIS_PORT", defaultRedisPort, 1, 65535),
		CacheEnabled:           Bool("CACHE_ENABLED", true),
		CacheTimeoutMS:         intInRange("CACHE_TIMEOUT_MS", defaultCacheTimeoutMS, 1, 1<<31-1),
		DeploymentEnvironment:  stringOr("DEPLOYMENT_ENVIRONMENT", defaultDeploymentEnvironment),
		Environment:            stringOr("ENVIRONMENT", defaultEnvironment),
	}

	required := []struct {
		name  string
		value string
	}{
		{"DATABASE_WRITER_URL", cfg.DatabaseWriterURL},
		{"DATABASE_READER_URL", cfg.DatabaseReaderURL},
		{"GRPC_API_KEY", cfg.GRPCAPIKey},
		{"TRACKING_CARRIER_API_KEY", cfg.TrackingCarrierAPIKey},
	}
	for _, r := range required {
		if r.value == "" {
			return Config{}, fmt.Errorf("config: %s is required and must not be empty", r.name)
		}
	}

	if !validEnvironments[cfg.Environment] {
		return Config{}, fmt.Errorf(
			"config: ENVIRONMENT=%q is not one of development, test, production", cfg.Environment)
	}

	return cfg, nil
}

// Bool reads a flag, falling back when the variable is absent, empty, or
// unrecognized. Exported because the route-mounting decision reads
// E2E_TESTING_ENABLED before a full Config exists, and a failed Load must not
// change whether a route is served.
//
// CONTRACT: Accept only true/1/yes/on and false/0/no/off, case-insensitively. A
// flag switching on for many spellings is one enabled by accident.
// See [[env-files]]
func Bool(name string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	default:
		return fallback
	}
}

func stringOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func optionalString(name string) *string {
	v := os.Getenv(name)
	if v == "" {
		return nil
	}
	return &v
}

func intInRange(name string, fallback, minimum, maximum int) int {
	v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil || v < minimum || v > maximum {
		return fallback
	}
	return v
}

func floatOr(name string, fallback float64) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv(name)), 64)
	if err != nil {
		return fallback
	}
	return v
}
