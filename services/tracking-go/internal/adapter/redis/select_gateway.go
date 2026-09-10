package redis

import (
	"log/slog"

	goredis "github.com/redis/go-redis/v9"
)

// SelectGateway turns CACHE_ENABLED into a GATEWAY, the only place in the
// service that branches on that flag. Its second return is the CLOSER, nil when
// nothing was built; the caller defers it or the pool outlives shutdown.
//
// CONTRACT: The client arrives as a FACTORY, not a client. The guarantee is that
// NO CLIENT IS CONSTRUCTED with the flag off, so a runtime boots with no
// reachable Redis; a prebuilt client has already dialled before this sees the
// flag. A factory makes that assertable — a test counts the invocations.
//
// CONTRACT: Return a NULL OBJECT, never nil. Every read and invalidation path
// calls straight through with no flag check of its own, so nil panics on the
// first request instead of skipping the cache. See [[x-cache-response-header]]
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
