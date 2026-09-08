package redis

import (
	"strconv"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// NewClient builds the process-wide Redis client. Both timeouts share one
// budget: a connect slower than the operation's limit has already blown it.
//
// CONTRACT: MaxRetries stays -1, which is how go-redis spells "disabled" — 0
// means its default of 3. A retry spends the budget TWICE, turning the fail-open
// guarantee into double the latency on the path the cache exists to speed up.
//
// CONTRACT: Call this ONLY when CACHE_ENABLED is true; otherwise bind
// NewNullGateway, so the service starts with no reachable Redis.
// See [[x-cache-response-header]]
func NewClient(host string, port, timeoutMS int) *goredis.Client {
	budget := time.Duration(timeoutMS) * time.Millisecond
	return goredis.NewClient(&goredis.Options{
		Addr:         host + ":" + strconv.Itoa(port),
		DialTimeout:  budget,
		ReadTimeout:  budget,
		WriteTimeout: budget,
		MaxRetries:   -1,
	})
}
