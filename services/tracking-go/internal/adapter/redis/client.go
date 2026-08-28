package redis

import (
	"strconv"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// NewClient builds the process-wide Redis client.
//
// BOTH timeouts get the SAME budget: a connect that takes longer than the
// operation is allowed to take has already blown it, so there is no reason to
// give the two different numbers.
//
// MaxRetries is -1, which is how go-redis spells "disabled" (0 means "use the
// default of 3", which is the trap). That is load-bearing rather than a default
// worth restating: a retry would spend the budget TWICE, turning the 50ms
// fail-open guarantee into a 100ms one on exactly the path the cache exists to
// speed up.
//
// Call this ONLY when CACHE_ENABLED is true. With the cache disabled, nothing
// should build a client at all — bind NewNullGateway instead, so a service
// running with CACHE_ENABLED=false needs no reachable Redis to start.
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
