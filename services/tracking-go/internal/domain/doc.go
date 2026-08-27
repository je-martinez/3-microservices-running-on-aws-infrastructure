// Package domain holds the pure business rules of the Tracking service.
//
// PURITY RULE (enforced by review, and by the import test in Task 5): this
// package and every file in it may import ONLY the Go standard library. No gin,
// no sqlc-generated package, no redis, no aws-sdk, no grpc, no otel, and not
// even net/http. Business rules that compile without a framework are business
// rules that can be tested without one.
package domain

// Version is the schema-independent marker used by the scaffold test to prove
// the toolchain compiles and runs this module. It has no runtime meaning.
const Version = "tracking-go"
