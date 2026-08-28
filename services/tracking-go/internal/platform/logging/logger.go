package logging

import (
	"log/slog"
	"os"
)

// ServiceName is this service's service_name on every log line, and the value
// of OTEL_SERVICE_NAME in the Dockerfile. One spelling, one place.
const ServiceName = "tracking"

// Install points the default slog logger at stdout with our JSON shape, so a
// package that reaches for slog.Info without a logger still emits the schema.
//
// deploymentEnvironment comes from DEPLOYMENT_ENVIRONMENT (default "local"); it
// is passed in rather than read here so this package stays free of config.
func Install(deploymentEnvironment string) *slog.Logger {
	log := New(os.Stdout, ServiceName, deploymentEnvironment)
	slog.SetDefault(log)
	return log
}
