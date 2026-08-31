package sqs_test

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
)

// THE GUARD THIS FILE EXISTS TO BE.
//
// publisher_test.go asserts what the PRODUCER emits. That proves nothing about
// what the CONSUMER accepts, and this repo has the receipt: the envelope emitted
// `shipping_address` as a JSON string, the pipeline's Zod schema requires an
// object, and the producer's own wire-shape test asserted the string — so the
// suite was green while every status change with an address silently lost its
// email and its WebSocket push. A `transient: false` PermanentError CONSUMES the
// record; the producer logs success and the DLQ stays empty.
//
// So this test reads the ACTUAL consumer schema off disk and checks the Go
// envelope against it, rather than against a Go-side restatement of it that can
// drift the same way a comment can.
//
// # Why regex over TypeScript and not something stronger
//
// Weighed and rejected:
//
//   - Running the real Zod validator (node + vitest from a Go test). Highest
//     fidelity, but it makes `go test ./...` depend on a Node toolchain, a pnpm
//     install and a second language's build being green — a Go-only change could
//     then fail for reasons that have nothing to do with it. The pipeline's own
//     vitest suite already runs Zod; duplicating it here buys fidelity we already
//     have somewhere.
//   - A shared JSON-schema fixture both sides validate against. Genuinely the
//     right answer for a contract with many producers, and the direction to go if
//     a fourth producer appears. Today it means introducing a third artifact,
//     generating it from Zod, wiring it into two build systems, and keeping THAT
//     in sync — a fixture nobody regenerates is exactly the stale restatement
//     this test is trying to avoid.
//   - A golden envelope file checked by both sides. Pins one example, not the
//     rule. It would have caught this bug, and would not catch the next field
//     whose fixture happens to be NULL.
//
// What is left is cheap, has no new dependencies, and fails on the ONE thing that
// actually went wrong: a Go type whose JSON shape disagrees with the combinator
// the consumer declares. The regex is deliberately narrow — if the schema is
// reformatted past it, the test FAILS LOUDLY (it cannot find the field) rather
// than passing vacuously. That failure mode is the point: a guard that goes quiet
// when it stops understanding its input is not a guard.
const zodHandlerPath = "../../../../../functions/events-pipeline/src/handlers/tracking-status-changed.ts"

// zodFieldDecl finds `  <field>: <combinator chain>,` inside the payload schema.
var zodFieldDecl = regexp.MustCompile(`(?m)^\s{2}(\w+):\s*(.+?),?\s*$`)

func loadZodPayloadSchema(t *testing.T) map[string]string {
	t.Helper()

	source, err := os.ReadFile(zodHandlerPath)
	if err != nil {
		t.Fatalf("cannot read the consumer's schema at %s: %v\n"+
			"This test is the ONLY thing checking the Go envelope against the real "+
			"Zod contract. If the file moved, repoint it — do not delete the test.",
			zodHandlerPath, err)
	}

	const open = "const TrackingStatusChangedPayloadSchema = z.object({"
	start := strings.Index(string(source), open)
	if start < 0 {
		t.Fatalf("could not find %q in %s; the schema was renamed or restructured, "+
			"so this guard no longer reads it", open, zodHandlerPath)
	}
	body := string(source)[start+len(open):]
	end := strings.Index(body, "\n});")
	if end < 0 {
		t.Fatal("could not find the end of TrackingStatusChangedPayloadSchema")
	}
	body = body[:end]

	fields := map[string]string{}
	for _, match := range zodFieldDecl.FindAllStringSubmatch(body, -1) {
		fields[match[1]] = strings.TrimSuffix(strings.TrimSpace(match[2]), ",")
	}
	if len(fields) == 0 {
		t.Fatalf("parsed zero fields out of %s; the guard has stopped understanding its input", zodHandlerPath)
	}
	return fields
}

// jsonKindOfZod maps the leading combinator to the JSON type it accepts.
// Deliberately partial: an unrecognised combinator FAILS the test rather than
// being skipped, so a schema that grows a shape this test cannot reason about
// gets a human's attention instead of silent green.
func jsonKindOfZod(t *testing.T, field, decl string) string {
	t.Helper()
	switch {
	case strings.HasPrefix(decl, "z.record("), strings.HasPrefix(decl, "z.object("):
		return "object"
	// A named schema reference (EnvelopeSchema's `author: AuthorSchema`). Every
	// z.object() in this contract is a JSON object; the referenced schema's own
	// FIELDS are checked by this test's second case, which parses AuthorSchema
	// directly.
	case strings.HasSuffix(decl, "Schema"):
		return "object"
	case strings.HasPrefix(decl, "z.array("):
		return "array"
	case strings.HasPrefix(decl, "z.string("), strings.HasPrefix(decl, "z.enum("):
		return "string"
	case strings.HasPrefix(decl, "z.number("):
		return "number"
	case strings.HasPrefix(decl, "z.boolean("):
		return "boolean"
	default:
		t.Fatalf("field %q declares %q, a combinator this guard does not know. "+
			"Teach it the mapping rather than removing the field from the check.", field, decl)
		return ""
	}
}

func jsonKindOfValue(v any) string {
	switch v.(type) {
	case map[string]any:
		return "object"
	case []any:
		return "array"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	case nil:
		return "null"
	default:
		return "unknown"
	}
}

// TestEnvelopePayloadMatchesTheConsumerZodTypes is the regression gate for the
// shipping_address defect: every payload key the Go publisher emits must carry
// the JSON TYPE the pipeline's Zod schema declares for it.
func TestEnvelopePayloadMatchesTheConsumerZodTypes(t *testing.T) {
	zodFields := loadZodPayloadSchema(t)

	client := &fakeSQS{}
	p := sqs.NewPublisher(client, "https://sqs/queue",
		stubResolver{user: grpcusers.ResolvedUser{
			InternalID: "usr_abc", Email: "person@example.com", FullName: "Ada Lovelace"}},
		quietLog())
	p.PublishTrackingStatusChanged(t.Context(), fullInput())

	payload, ok := decodeEnvelope(t, client.last())["payload"].(map[string]any)
	if !ok {
		t.Fatal("payload is not a JSON object")
	}

	for field, value := range payload {
		decl, declared := zodFields[field]
		if !declared {
			// Not fatal by itself — Zod strips unknown keys rather than
			// rejecting them — but it is always worth knowing about, because a
			// field the consumer never reads is a field the producer is paying
			// to send.
			t.Errorf("payload carries %q, which the consumer's schema does not declare", field)
			continue
		}
		want := jsonKindOfZod(t, field, decl)
		if got := jsonKindOfValue(value); got != want {
			t.Errorf("payload.%s is a JSON %s, but %s declares %s (%s).\n"+
				"A type mismatch here is a PermanentError: the record is CONSUMED, not retried, "+
				"and the email and the WebSocket push are lost while this service logs success.",
				field, got, zodHandlerPath, want, decl)
		}
	}

	// The other direction: a REQUIRED field the producer stopped sending is the
	// same PermanentError, and the loop above cannot see it.
	for field, decl := range zodFields {
		if strings.Contains(decl, ".optional()") {
			continue
		}
		if _, present := payload[field]; !present {
			t.Errorf("the consumer REQUIRES payload.%s (%s) and the producer does not send it", field, decl)
		}
	}
}

// TestFullEnvelopeMatchesTheRootSchemaTypes does the same for the envelope root,
// whose schema lives in a different file.
func TestFullEnvelopeMatchesTheRootSchemaTypes(t *testing.T) {
	const rootSchemaPath = "../../../../../functions/events-pipeline/src/domain/envelope.ts"

	source, err := os.ReadFile(rootSchemaPath)
	if err != nil {
		t.Fatalf("cannot read %s: %v", rootSchemaPath, err)
	}

	for _, schema := range []struct {
		open   string
		object func(t *testing.T, envelope map[string]any) map[string]any
	}{
		{
			open:   "export const EnvelopeSchema = z.object({",
			object: func(_ *testing.T, envelope map[string]any) map[string]any { return envelope },
		},
		{
			open: "export const AuthorSchema = z.object({",
			object: func(t *testing.T, envelope map[string]any) map[string]any {
				t.Helper()
				author, ok := envelope["author"].(map[string]any)
				if !ok {
					t.Fatal("author is not a JSON object")
				}
				return author
			},
		},
	} {
		t.Run(schema.open, func(t *testing.T) {
			start := strings.Index(string(source), schema.open)
			if start < 0 {
				t.Fatalf("could not find %q in %s", schema.open, rootSchemaPath)
			}
			body := string(source)[start+len(schema.open):]
			end := strings.Index(body, "\n});")
			if end < 0 {
				t.Fatal("could not find the end of the schema")
			}
			fields := map[string]string{}
			for _, match := range zodFieldDecl.FindAllStringSubmatch(body[:end], -1) {
				fields[match[1]] = strings.TrimSuffix(strings.TrimSpace(match[2]), ",")
			}
			if len(fields) == 0 {
				t.Fatalf("parsed zero fields out of %s", schema.open)
			}

			client := &fakeSQS{}
			p := sqs.NewPublisher(client, "https://sqs/queue",
				stubResolver{user: grpcusers.ResolvedUser{Email: "person@example.com"}}, quietLog())
			p.PublishTrackingStatusChanged(t.Context(), fullInput())
			target := schema.object(t, decodeEnvelope(t, client.last()))

			for field, value := range target {
				decl, declared := fields[field]
				if !declared {
					t.Errorf("%q is emitted but not declared in %s", field, schema.open)
					continue
				}
				// `.nullable()` widens the accepted set; this producer never
				// emits null anywhere, so it is only ever a non-issue here.
				want := jsonKindOfZod(t, field, decl)
				if got := jsonKindOfValue(value); got != want {
					t.Errorf("%s is a JSON %s, but the schema declares %s (%s)", field, got, want, decl)
				}
			}
			for field, decl := range fields {
				if strings.Contains(decl, ".optional()") {
					continue
				}
				if _, present := target[field]; !present {
					t.Errorf("the consumer REQUIRES %s (%s) and the producer does not send it", field, decl)
				}
			}
		})
	}
}

// TestNoEnvelopeFieldIsEverNull sweeps the WHOLE emitted document for nulls,
// under every combination of the absent-able inputs.
//
// OMITTED, NEVER NULL is a rule about the whole envelope, not about the three
// fields that happen to have their own test today. Every schema here is
// `.optional()` and none is `.nullable()`, so a single null anywhere is a
// PermanentError — and a per-field test only ever guards the fields somebody
// remembered.
func TestNoEnvelopeFieldIsEverNull(t *testing.T) {
	for name, mutate := range map[string]func(in *sqs.StatusChanged){
		"everything present":        func(*sqs.StatusChanged) {},
		"no cognito_sub":            func(in *sqs.StatusChanged) { in.CognitoSub = "" },
		"no shipping address":       func(in *sqs.StatusChanged) { in.ShippingAddress = nil },
		"address is JSON null":      func(in *sqs.StatusChanged) { in.ShippingAddress = json.RawMessage(`null`) },
		"address is empty bytes":    func(in *sqs.StatusChanged) { in.ShippingAddress = json.RawMessage{} },
		"no history":                func(in *sqs.StatusChanged) { in.History = nil },
		"nothing optional at all":   func(in *sqs.StatusChanged) { in.CognitoSub, in.ShippingAddress, in.History = "", nil, nil },
		"no previous status":        func(in *sqs.StatusChanged) { in.PreviousStatus = "" },
		"no tracking number":        func(in *sqs.StatusChanged) { in.TrackingNumber = "" },
		"empty actor":               func(in *sqs.StatusChanged) { in.Actor = "" },
		"address with a null field": func(in *sqs.StatusChanged) { in.ShippingAddress = json.RawMessage(`{"line2": null}`) },
	} {
		t.Run(name, func(t *testing.T) {
			client := &fakeSQS{}
			p := sqs.NewPublisher(client, "q",
				stubResolver{user: grpcusers.ResolvedUser{Email: "a@b.com"}}, quietLog())
			in := fullInput()
			mutate(&in)
			p.PublishTrackingStatusChanged(t.Context(), in)

			sent := client.last()
			if sent == nil {
				t.Fatal("nothing was published")
			}
			envelope := decodeEnvelope(t, sent)

			// The envelope's OWN keys and its author's. Not payload.history's
			// entries (checked in publisher_test.go) and deliberately NOT the
			// interior of shipping_address: that document is owned by Orders and
			// forwarded unparsed, and `z.record(z.string(), z.unknown())` accepts
			// a null INSIDE it. Rejecting one here would make this service the
			// thing that breaks when Orders adds a nullable field.
			assertNoNulls(t, envelope, "", map[string]bool{"payload.shipping_address": true})
		})
	}
}

// assertNoNulls walks the decoded document reporting any null it reaches, other
// than inside a subtree explicitly exempted by path.
func assertNoNulls(t *testing.T, node any, path string, exempt map[string]bool) {
	t.Helper()
	if exempt[path] {
		return
	}
	switch typed := node.(type) {
	case nil:
		t.Errorf("%s is null. Every optional field in this contract is .optional() and NOT "+
			".nullable(), so a null is a PermanentError that consumes the record and loses the "+
			"email and the WebSocket push. Omit the key instead.", path)
	case map[string]any:
		for key, value := range typed {
			child := key
			if path != "" {
				child = path + "." + key
			}
			assertNoNulls(t, value, child, exempt)
		}
	case []any:
		for i, value := range typed {
			assertNoNulls(t, value, path+"[]", exempt)
			_ = i
		}
	}
}
