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

// requestIDPattern is anchored at both ends. The length is EXACT rather than a
// bound, because this pattern is the only thing standing between an untrusted
// header and every log line the request produces.
//
// \A and \z rather than ^ and $: Go's $ matches before a trailing newline is
// not the issue (that is Ruby/PCRE), but being explicit about "end of TEXT"
// documents that a newline-injected value must never fullmatch.
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
// WHY VALIDATE. x-request-id is attacker-controlled input on any public
// endpoint, and by design its value is copied onto EVERY log line of the
// resulting flow and forwarded downstream over gRPC and SQS. So an unbounded
// string, a control character or an injected newline does not contaminate one
// field on one line — it contaminates a whole flow's records at once, in a field
// that log queries, dashboards and alerting rules all assume is well-formed.
//
// WHY DISCARD SILENTLY RATHER THAN ANSWER 400. A correlation header is a
// convenience, never a contract the caller must satisfy to be served. The
// senders of a malformed value are misconfigured clients, header-mangling
// proxies and curious testers, none of whom asked for anything illegitimate;
// failing their otherwise valid request would turn an observability aid into an
// outage. The flow stays correlated end to end — just not with the caller's id.
func ResolveRequestID(headerValue string) string {
	if requestIDPattern.MatchString(headerValue) {
		return headerValue
	}
	return GenerateRequestID()
}
