package grpcusers_test

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"sync"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers"
	usersv1 "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers/gen"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// fakeUsers is a real gRPC server implementing users.v1.Users.
type fakeUsers struct {
	usersv1.UnimplementedUsersServer

	mu       sync.Mutex
	response *usersv1.UserResponse
	err      error
	// lastMetadata records what the client actually put on the wire.
	lastMetadata metadata.MD
	lastID       string
}

func (f *fakeUsers) GetUserById(ctx context.Context, req *usersv1.GetUserByIdRequest) (*usersv1.UserResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastMetadata, _ = metadata.FromIncomingContext(ctx)
	f.lastID = req.GetId()
	if f.err != nil {
		return nil, f.err
	}
	return f.response, nil
}

// dialFake starts the fake over bufconn and returns a client wired to it.
func dialFake(t *testing.T, fake *fakeUsers, apiKey string) *grpcusers.Client {
	t.Helper()
	listener := bufconn.Listen(1024 * 1024)
	server := grpc.NewServer()
	usersv1.RegisterUsersServer(server, fake)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return listener.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	return grpcusers.NewClient(conn, apiKey)
}

func TestResolveMapsTheResponse(t *testing.T) {
	fake := &fakeUsers{response: &usersv1.UserResponse{
		Id:         "usr_abc",
		Email:      "person@example.com",
		FullName:   "Ada Lovelace",
		CognitoSub: "sub-uuid",
		// PII the client must never carry through. Present on the wire so the
		// mapping is proven to DROP it, not merely to not ask for it.
		Address: &usersv1.Address{Line1: "1 Main St", City: "Springfield"},
	}}
	client := dialFake(t, fake, "internal-key")

	got, err := client.Resolve(t.Context(), "sub-uuid")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got.InternalID != "usr_abc" {
		t.Errorf("InternalID = %q", got.InternalID)
	}
	if got.CognitoSub != "sub-uuid" {
		t.Errorf("CognitoSub = %q", got.CognitoSub)
	}
	if got.Email != "person@example.com" {
		t.Errorf("Email = %q", got.Email)
	}
	if got.FullName != "Ada Lovelace" {
		t.Errorf("FullName = %q", got.FullName)
	}
}

// ONLY NotFound is "no such user". Every other status must PROPAGATE — an outage
// must never read as "this user does not exist".
func TestOnlyNotFoundMeansUnknownUser(t *testing.T) {
	tests := []struct {
		code        codes.Code
		wantUnknown bool
	}{
		{codes.NotFound, true},
		{codes.Unavailable, false},
		{codes.DeadlineExceeded, false},
		{codes.Unauthenticated, false},
		{codes.PermissionDenied, false},
		{codes.Internal, false},
		{codes.ResourceExhausted, false},
	}
	for _, tt := range tests {
		t.Run(tt.code.String(), func(t *testing.T) {
			fake := &fakeUsers{err: status.Error(tt.code, "boom")}
			client := dialFake(t, fake, "internal-key")

			_, err := client.Resolve(t.Context(), "sub-uuid")
			if err == nil {
				t.Fatal("Resolve returned no error")
			}
			isUnknown := errors.Is(err, grpcusers.ErrUnknownUser)
			if isUnknown != tt.wantUnknown {
				t.Errorf("errors.Is(err, ErrUnknownUser) = %v for %s, want %v — an outage must not read as 'no such user'",
					isUnknown, tt.code, tt.wantUnknown)
			}
			if !tt.wantUnknown {
				// The transport status must survive for the HTTP layer to map to 500.
				if st, ok := status.FromError(err); !ok || st.Code() != tt.code {
					t.Errorf("the gRPC status did not propagate: %v", err)
				}
			}
		})
	}
}

// The api key travels as PER-CALL metadata, lowercase, never in channel creds.
func TestAPIKeyTravelsAsPerCallMetadata(t *testing.T) {
	fake := &fakeUsers{response: &usersv1.UserResponse{Id: "usr_abc"}}
	client := dialFake(t, fake, "internal-key-value")

	if _, err := client.Resolve(t.Context(), "sub-uuid"); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	got := fake.lastMetadata.Get("x-api-key")
	if len(got) != 1 || got[0] != "internal-key-value" {
		t.Errorf("x-api-key metadata = %v, want [internal-key-value]", got)
	}
}

// x-request-id is forwarded when the context has one.
func TestRequestIDIsForwarded(t *testing.T) {
	fake := &fakeUsers{response: &usersv1.UserResponse{Id: "usr_abc"}}
	client := dialFake(t, fake, "k")

	ctx := logging.WithLogFields(t.Context(),
		slog.String(logging.KeyRequestID, "req_7gK3mP1vXz9wLq2bN8rRt4Yc"))
	if _, err := client.Resolve(ctx, "sub-uuid"); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	got := fake.lastMetadata.Get("x-request-id")
	if len(got) != 1 || got[0] != "req_7gK3mP1vXz9wLq2bN8rRt4Yc" {
		t.Errorf("x-request-id metadata = %v, want the context's id", got)
	}
}

// OMITTED, never sent empty: an x-request-id: "" would be a correlation value
// that correlates nothing, indistinguishable in Users' logs from a real one.
func TestRequestIDIsOmittedWhenAbsent(t *testing.T) {
	fake := &fakeUsers{response: &usersv1.UserResponse{Id: "usr_abc"}}
	client := dialFake(t, fake, "k")

	if _, err := client.Resolve(t.Context(), "sub-uuid"); err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	fake.mu.Lock()
	defer fake.mu.Unlock()
	if got := fake.lastMetadata.Get("x-request-id"); len(got) != 0 {
		t.Errorf("x-request-id = %v on a context with no id; it must be omitted, never empty", got)
	}
}

// The request accepts EITHER identifier and is passed through verbatim.
func TestResolveAcceptsEitherIdentifier(t *testing.T) {
	for _, identifier := range []string{"sub-uuid", "usr_abc"} {
		t.Run(identifier, func(t *testing.T) {
			fake := &fakeUsers{response: &usersv1.UserResponse{Id: "usr_abc"}}
			client := dialFake(t, fake, "k")

			if _, err := client.Resolve(t.Context(), identifier); err != nil {
				t.Fatalf("Resolve: %v", err)
			}
			fake.mu.Lock()
			defer fake.mu.Unlock()
			if fake.lastID != identifier {
				t.Errorf("id = %q, want %q passed through verbatim", fake.lastID, identifier)
			}
		})
	}
}

// The asymmetry is deliberate: an absent EMAIL disqualifies the notification, an
// absent NAME is cosmetic and stays "".
func TestEmptyEmailAndNameAreCarriedAsEmptyStrings(t *testing.T) {
	fake := &fakeUsers{response: &usersv1.UserResponse{Id: "usr_abc", CognitoSub: "sub"}}
	client := dialFake(t, fake, "k")

	got, err := client.Resolve(t.Context(), "sub")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got.Email != "" {
		t.Errorf("Email = %q, want \"\" — the publisher checks for it and bails out", got.Email)
	}
	if got.FullName != "" {
		t.Errorf("FullName = %q, want \"\" kept as-is", got.FullName)
	}
}

// An empty api key is a construction-time failure, not a runtime UNAUTHENTICATED.
func TestDialRejectsAnEmptyAPIKey(t *testing.T) {
	if _, err := grpcusers.Dial("users:50051", ""); err == nil {
		t.Fatal("Dial accepted an empty api key")
	}
}
