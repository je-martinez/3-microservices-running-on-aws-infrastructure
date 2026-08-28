package redis

import (
	"log/slog"

	goredis "github.com/redis/go-redis/v9"
)

// SelectGateway turns CACHE_ENABLED into a GATEWAY, and it is the only place in
// the service that branches on that flag.
//
// # Why the client arrives as a FACTORY rather than as a client
//
// Because the strong guarantee is not "a disabled cache uses the null gateway" —
// it is that NO CLIENT IS CONSTRUCTED AT ALL. Taking an already-built client
// would satisfy the first while quietly violating the second: the caller would
// have dialled Redis, opened a pool and held it for the process's lifetime before
// this function ever saw the flag. A factory makes "not constructed" the literal
// behaviour, and makes it ASSERTABLE — a test counts the invocations.
//
// That guarantee is what lets a runtime with CACHE_ENABLED=false boot with no
// reachable Redis at all.
//
// # It returns a NULL OBJECT, never nil
//
// Every read and invalidation path calls straight through the gateway with no
// flag check of its own, so a nil would panic on the first request instead of
// skipping the cache. The null gateway answers "miss" forever and discards every
// write, which gives the whole downstream exactly one shape.
//
// The second return is the CLOSER, and it is nil when nothing was built. The
// caller defers it; without it the client's connection pool outlives the process's
// shutdown path.
func SelectGateway(
	enabled bool,
	newClient func() *goredis.Client,
	metrics Metrics,
	log *slog.Logger,
) (Gateway, func() error) {
	if !enabled {
		return NewNullGateway(), nil
	}

	client := newClient()
	return NewGateway(client, metrics, log), client.Close
}
