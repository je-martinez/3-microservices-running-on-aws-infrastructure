package logging

import (
	"crypto/rand"
	"regexp"
	"strings"
)

// RequestIDHeader carries the cross-service correlation id between services.
const RequestIDHeader = "x-request-id"

// The id is deliberately NOT a second trace_id: it carries no tracing semantics
// and needs no SDK, which is exactly why it exists — the runtimes at the ends of
// these flows (the events-pipeline Lambda, the realtime WebSocket handlers) have
// no OTel SDK at all, so trace_id is absent on precisely the hops where
// reconstructing a flow end to end matters most.
const (
	requestIDPrefix = "req_"
	requestIDLength = 24
	nanoAlphabet    = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
)

// CONTRACT: Keep this anchored with \A and \z and the length EXACT, not a
// bound. It is the only thing between an untrusted header and every log line the
// request produces, and a newline-injected value must never fullmatch.
var requestIDPattern = regexp.MustCompile(`\Areq_[A-Za-z0-9]{24}\z`)

// GenerateRequestID mints a fresh id, e.g. req_7gK3mP1vXz9wLq2bN8rRt4Yc.
func GenerateRequestID() string {
	buf := make([]byte, requestIDLength)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand does not fail on any supported platform; if it ever did,
		// a degraded id is still better than failing the request this id only
		// exists to describe.
		for i := range buf {
			buf[i] = byte(i)
		}
	}
	var sb strings.Builder
	sb.Grow(len(requestIDPrefix) + requestIDLength)
	sb.WriteString(requestIDPrefix)
	for _, b := range buf {
		sb.WriteByte(nanoAlphabet[int(b)%len(nanoAlphabet)])
	}
	return sb.String()
}

// ResolveRequestID returns the caller's id when it is one of ours, else a fresh
// one.
//
// CONTRACT: Validate before use. x-request-id is attacker-controlled and its
// value is copied onto every log line of the flow and forwarded over gRPC and
// SQS, so an injected newline contaminates a whole flow's records at once.
//
// CONTRACT: Discard a bad value SILENTLY, never 400. A correlation header is a
// convenience, and failing an otherwise valid request turns an observability aid
// into an outage. The flow stays correlated, just not with the caller's id.
// See [[logging-context]]
func ResolveRequestID(headerValue string) string {
	if requestIDPattern.MatchString(headerValue) {
		return headerValue
	}
	return GenerateRequestID()
}
