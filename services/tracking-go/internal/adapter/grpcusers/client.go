// Package grpcusers is the OUTBOUND gRPC client to the Users service.
//
// It exists for exactly one question — "which internal usr_ id belongs to this
// identifier?" — because the gateway only ever hands this service a Cognito sub
// while a persisted tracking.user_id is a usr_ id. Everything here points one
// way: outward, calling users.v1.Users. This service serves no gRPC.
//
// # NOT_FOUND is an answer, not an error
//
// Users answers NotFound for an identifier it has never seen. That is a
// perfectly ordinary outcome — a token minted for a Cognito user whose record was
// never created, or was deleted — and it becomes ErrUnknownUser here rather than
// leaking a transport error into handlers that have no business knowing this
// service talks gRPC at all.
//
// EVERY OTHER STATUS PROPAGATES, deliberately: Unavailable, DeadlineExceeded,
// Unauthenticated and the rest keep their gRPC status so the HTTP layer maps them
// to 500. A caller must never treat an outage as "this user doesn't exist" and,
// say, write a row attributing the shipment to nobody.
//
// # Never log a UserResponse
//
// The response carries the user's address and email — PII. Nothing here logs the
// message, and nothing that receives a ResolvedUser should either; log email_hash
// instead.
package grpcusers

import (
	"context"
	"errors"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	usersv1 "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers/gen"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// Metadata keys. gRPC LOWERCASES metadata keys on the wire, so these must be
// lowercase to match what Users reads them as.
const (
	apiKeyMetadataKey    = "x-api-key"
	requestIDMetadataKey = "x-request-id"
)

// DefaultTimeout bounds every call. A gRPC call with NO deadline waits forever,
// which in a request path means a hung Users pins a worker until something else
// times out. Short because the call is a single indexed lookup: if it has not
// answered in two seconds it is not about to.
const DefaultTimeout = 2 * time.Second

// ErrUnknownUser is the domain fact behind a NotFound. The HTTP layer maps it to
// 404 unknown_user; everything else maps to 500.
var ErrUnknownUser = errors.New("grpcusers: no such user")

// ResolvedUser is the subset of users.v1.UserResponse this service has a use for.
//
// A domain value, not the proto message, so nothing downstream imports the
// generated package or holds a reference into gRPC's object graph.
//
// Deliberately NOT carrying the ADDRESS, even though UserResponse.address exists:
// no caller in this service needs it, and pulling it through would carry PII
// around for nothing. The REST creation endpoint takes shipping_address in the
// request body.
type ResolvedUser struct {
	// InternalID is the usr_ id — what tracking.user_id stores.
	InternalID string
	// CognitoSub is the sub Users has on file. Echoed back for the caller to
	// sanity check; the RPC accepts either identifier.
	CognitoSub string
	// Email is PII, consumed ONLY by the events publisher to address the
	// notification. Never logged, never returned over REST.
	//
	// "" means ABSENT (proto3 has no null). The publisher checks for it and
	// aborts before building anything, because the pipeline's handler rejects a
	// payload without an email as a PERMANENT error — the record is consumed and
	// the mail is never sent.
	Email string
	// FullName is PII too, and its "" is KEPT AS-IS rather than normalized —
	// deliberately different from Email. The two are different kinds of missing:
	// an absent address means the notification cannot be delivered at all, so the
	// publisher must distinguish it; an absent name is cosmetic, the mail still
	// sends, and the payload field is a plain string the template interpolates.
	FullName string
}

// Client resolves an identifier through users.v1.Users.
type Client struct {
	conn    *grpc.ClientConn
	stub    usersv1.UsersClient
	apiKey  string
	timeout time.Duration
}

// Dial builds a client over a NEW insecure channel to target.
//
// Insecure because this hop is inside the private network and is authenticated by
// the shared internal key. The channel is a connection pool — building one per
// call would pay TCP + HTTP/2 setup on every request and leak sockets under load.
func Dial(target, apiKey string) (*Client, error) {
	if apiKey == "" {
		// An empty key would be sent as an empty x-api-key and rejected by Users
		// with UNAUTHENTICATED at runtime — a failure much better detected here,
		// where the misconfiguration actually is.
		return nil, errors.New("grpcusers: api key must not be empty")
	}
	conn, err := grpc.NewClient(NormalizeTarget(target),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		// Go has no opentelemetry-instrument equivalent: the outbound spans are
		// wired here, in code.
		grpc.WithStatsHandler(otelgrpc.NewClientHandler()),
	)
	if err != nil {
		return nil, err
	}
	return NewClient(conn, apiKey), nil
}

// NewClient wraps an existing connection. Used by Dial and by tests over bufconn.
func NewClient(conn *grpc.ClientConn, apiKey string) *Client {
	return &Client{
		conn:    conn,
		stub:    usersv1.NewUsersClient(conn),
		apiKey:  apiKey,
		timeout: DefaultTimeout,
	}
}

// Close releases the channel.
func (c *Client) Close() error {
	if c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// Resolve looks up a user by Cognito sub OR internal usr_ id.
//
// GetUserById accepts BOTH identifiers — the .proto says so and Users' handler
// implements it — so the parameter takes the neutral name `identifier` rather
// than pretending it must be one or the other.
//
// Only NotFound becomes ErrUnknownUser; every other status propagates with its
// gRPC status intact.
func (c *Client) Resolve(ctx context.Context, identifier string) (ResolvedUser, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	ctx = metadata.NewOutgoingContext(ctx, c.callMetadata(ctx))

	response, err := c.stub.GetUserById(ctx, &usersv1.GetUserByIdRequest{Id: identifier})
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return ResolvedUser{}, ErrUnknownUser
		}
		return ResolvedUser{}, err
	}

	return ResolvedUser{
		InternalID: response.GetId(),
		CognitoSub: response.GetCognitoSub(),
		Email:      response.GetEmail(),
		FullName:   response.GetFullName(),
		// response.GetAddress() is deliberately NOT read — PII with no consumer.
	}, nil
}

// callMetadata builds what every outbound call carries.
//
// The api key travels PER-CALL rather than baked into channel credentials, so the
// channel stays a plain, inspectable object and the credential appears at exactly
// the place it is used.
//
// x-request-id is read from the ambient log context rather than threaded through
// Resolve's signature: the context is already how this service carries per-request
// identity into depth, and adding a correlation argument to every caller of a
// lookup would be a signature change per hop for a value none of them care about.
//
// The entry is OMITTED, not sent empty, when the context has no id — that happens
// outside a request (the TestMode progression's goroutine, a CLI or startup call),
// and an x-request-id: "" on the wire would be a correlation value that correlates
// nothing, indistinguishable in Users' logs from a real one until someone tried to
// search for it.
func (c *Client) callMetadata(ctx context.Context) metadata.MD {
	md := metadata.Pairs(apiKeyMetadataKey, c.apiKey)
	for _, field := range logging.LogFields(ctx) {
		if field.Key == logging.KeyRequestID {
			if id := field.Value.String(); id != "" {
				md.Set(requestIDMetadataKey, id)
			}
			break
		}
	}
	return md
}
