package config_test

import (
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/config"
)

// setRequired writes the four variables without which Load must fail.
func setRequired(t *testing.T) {
	t.Helper()
	t.Setenv("DATABASE_WRITER_URL", "mysql+pymysql://root:secret@db:3306/tracking")
	t.Setenv("DATABASE_READER_URL", "mysql+pymysql://root:secret@db:3306/tracking")
	t.Setenv("GRPC_API_KEY", "internal-key")
	t.Setenv("TRACKING_CARRIER_API_KEY", "carrier-key")
}

func TestLoadDefaults(t *testing.T) {
	setRequired(t)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() returned unexpected error: %v", err)
	}

	if cfg.Port != 8000 {
		t.Errorf("Port = %d, want 8000", cfg.Port)
	}
	if cfg.UsersGRPCURL != "users:50051" {
		t.Errorf("UsersGRPCURL = %q, want %q", cfg.UsersGRPCURL, "users:50051")
	}
	if cfg.EventsQueueURL != "" {
		t.Errorf("EventsQueueURL = %q, want empty", cfg.EventsQueueURL)
	}
	if cfg.AWSEndpointURL != nil {
		t.Errorf("AWSEndpointURL = %v, want nil", cfg.AWSEndpointURL)
	}
	if cfg.AWSRegion != "us-east-1" {
		t.Errorf("AWSRegion = %q, want us-east-1", cfg.AWSRegion)
	}
	if cfg.MetricsIntervalSeconds != 15.0 {
		t.Errorf("MetricsIntervalSeconds = %v, want 15", cfg.MetricsIntervalSeconds)
	}
	if cfg.RedisHost != "localhost" || cfg.RedisPort != 6379 {
		t.Errorf("Redis = %s:%d, want localhost:6379", cfg.RedisHost, cfg.RedisPort)
	}
	if !cfg.CacheEnabled {
		t.Error("CacheEnabled = false, want true")
	}
	if cfg.CacheTimeoutMS != 50 {
		t.Errorf("CacheTimeoutMS = %d, want 50", cfg.CacheTimeoutMS)
	}
	if cfg.DeploymentEnvironment != "local" {
		t.Errorf("DeploymentEnvironment = %q, want local", cfg.DeploymentEnvironment)
	}
	if cfg.Environment != "development" {
		t.Errorf("Environment = %q, want development", cfg.Environment)
	}
}

// The two flags default in OPPOSITE directions, deliberately. Forgetting
// METRICS_ENABLED must leave dashboards populated; forgetting
// E2E_TESTING_ENABLED must leave the mass-delete route unmounted.
func TestLoadFlagDefaultsPointOppositeWays(t *testing.T) {
	setRequired(t)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if !cfg.MetricsEnabled {
		t.Error("MetricsEnabled defaulted to false; a forgotten variable must not empty the dashboards")
	}
	if cfg.E2ETestingEnabled {
		t.Error("E2ETestingEnabled defaulted to true; a forgotten variable must not expose the mass-delete route")
	}
}

func TestLoadRequiresTheFourRequiredVariables(t *testing.T) {
	for _, missing := range []string{
		"DATABASE_WRITER_URL",
		"DATABASE_READER_URL",
		"GRPC_API_KEY",
		"TRACKING_CARRIER_API_KEY",
	} {
		t.Run("missing_"+missing, func(t *testing.T) {
			setRequired(t)
			t.Setenv(missing, "")

			if _, err := config.Load(); err == nil {
				t.Fatalf("Load() with %s empty returned no error", missing)
			}
		})
	}
}

func TestLoadBoolSpellings(t *testing.T) {
	tests := []struct {
		raw  string
		want bool
	}{
		{"true", true}, {"TRUE", true}, {"True", true},
		{"1", true}, {"yes", true}, {"YES", true}, {"on", true}, {"On", true},
		{"false", false}, {"FALSE", false}, {"0", false}, {"no", false}, {"off", false},
	}
	for _, tt := range tests {
		t.Run(tt.raw, func(t *testing.T) {
			setRequired(t)
			t.Setenv("CACHE_ENABLED", tt.raw)

			cfg, err := config.Load()
			if err != nil {
				t.Fatalf("Load(): %v", err)
			}
			if cfg.CacheEnabled != tt.want {
				t.Errorf("CACHE_ENABLED=%q gave %v, want %v", tt.raw, cfg.CacheEnabled, tt.want)
			}
		})
	}
}

// An unparseable flag falls back to the field's own default. It must never be a
// startup failure: refusing to boot over a malformed test-harness flag is the
// worse trade.
func TestLoadUnparseableValuesFallBackToDefaults(t *testing.T) {
	setRequired(t)
	t.Setenv("METRICS_ENABLED", "maybe")
	t.Setenv("E2E_TESTING_ENABLED", "perhaps")
	t.Setenv("PORT", "not-a-number")
	t.Setenv("METRICS_INTERVAL_SECONDS", "soon")
	t.Setenv("CACHE_TIMEOUT_MS", "-1")
	t.Setenv("REDIS_PORT", "99999")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() failed on unparseable optional values: %v", err)
	}
	if !cfg.MetricsEnabled {
		t.Error("unparseable METRICS_ENABLED must fall back to true")
	}
	if cfg.E2ETestingEnabled {
		t.Error("unparseable E2E_TESTING_ENABLED must fall back to false")
	}
	if cfg.Port != 8000 {
		t.Errorf("Port = %d, want the 8000 default", cfg.Port)
	}
	if cfg.MetricsIntervalSeconds != 15.0 {
		t.Errorf("MetricsIntervalSeconds = %v, want the 15 default", cfg.MetricsIntervalSeconds)
	}
	if cfg.CacheTimeoutMS != 50 {
		t.Errorf("CacheTimeoutMS = %d, want the 50 default (out of range)", cfg.CacheTimeoutMS)
	}
	if cfg.RedisPort != 6379 {
		t.Errorf("RedisPort = %d, want the 6379 default (out of range)", cfg.RedisPort)
	}
}

func TestLoadEnvironmentEnum(t *testing.T) {
	for _, valid := range []string{"development", "test", "production"} {
		t.Run("valid_"+valid, func(t *testing.T) {
			setRequired(t)
			t.Setenv("ENVIRONMENT", valid)

			cfg, err := config.Load()
			if err != nil {
				t.Fatalf("Load(): %v", err)
			}
			if cfg.Environment != valid {
				t.Errorf("Environment = %q, want %q", cfg.Environment, valid)
			}
		})
	}

	t.Run("rejects_other_values", func(t *testing.T) {
		setRequired(t)
		t.Setenv("ENVIRONMENT", "staging")

		if _, err := config.Load(); err == nil {
			t.Fatal("Load() accepted ENVIRONMENT=staging; the enum must reject it")
		}
	})
}

func TestLoadAWSEndpointURLIsAPointer(t *testing.T) {
	setRequired(t)
	t.Setenv("AWS_ENDPOINT_URL", "http://floci:4566")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	if cfg.AWSEndpointURL == nil || *cfg.AWSEndpointURL != "http://floci:4566" {
		t.Errorf("AWSEndpointURL = %v, want pointer to http://floci:4566", cfg.AWSEndpointURL)
	}
}

// EchoSQL is true everywhere except production — the Python `echo_sql` property.
func TestEchoSQL(t *testing.T) {
	for _, tt := range []struct {
		env  string
		want bool
	}{
		{"development", true}, {"test", true}, {"production", false},
	} {
		setRequired(t)
		t.Setenv("ENVIRONMENT", tt.env)

		cfg, err := config.Load()
		if err != nil {
			t.Fatalf("Load(): %v", err)
		}
		if cfg.EchoSQL() != tt.want {
			t.Errorf("EchoSQL() with ENVIRONMENT=%s = %v, want %v", tt.env, cfg.EchoSQL(), tt.want)
		}
	}
}
