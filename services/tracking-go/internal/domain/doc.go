// Package domain holds the pure business rules of the Tracking service.
//
// CONTRACT: This package may import ONLY the Go standard library — no gin, sqlc,
// redis, aws-sdk, grpc, otel, not even net/http. Rules that compile without a
// framework can be tested without one. See [[screaming-architecture]]
package domain

// Version is the schema-independent marker used by the scaffold test to prove
// the toolchain compiles and runs this module. It has no runtime meaning.
const Version = "tracking-go"
