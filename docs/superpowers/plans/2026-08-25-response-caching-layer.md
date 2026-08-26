---
title: Response Caching Layer Implementation Plan
type: plan
area: shared
status: draft
created: 2026-08-25
updated: 2026-08-25
tags:
  - type/plan
  - area/shared
  - status/draft
propagates-to:
  - "[[x-cache-response-header]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[users-service-design]]"
related:
  - "[[2026-08-25-response-caching-layer-design]]"
  - "[[x-cache-response-header]]"
  - "[[logging-context]]"
  - "[[current-caller-context]]"
  - "[[testing]]"
  - "[[env-files]]"
---

# Response Caching Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared-Redis, HTTP-layer response cache to Users, Orders and Tracking, reporting hit/miss/bypass through an `X-Cache` response header.

**Architecture:** Each service gains a `CacheGateway` (Redis transport: serialization, 50ms timeout, key building, metric/span/log emission), a `CachedRead` interceptor applied per cacheable route (idiomatic per framework), and a `CacheInvalidator` called from the write path strictly after the write commits. Orders and Tracking additionally cache the `cognito_sub -> user_id` identity mapping, because every response key carries `user_id` and that resolution otherwise sits on the critical path of a cache hit.

**Tech Stack:** Redis/Valkey via the existing `infra/modules/redis` ElastiCache replication group. `ioredis` (Users, already present), `StackExchange.Redis` (Orders, new), `redis-py` (Tracking, new). Metrics via each service's existing CloudWatch publisher. Playwright for E2E, Gatling JS for load.

**Spec:** `docs/superpowers/specs/2026-08-25-response-caching-layer-design.md`

## Global Constraints

- **Redis is already deployed.** No new Terraform module. `infra/modules/redis` provisions the replication group; `REDIS_HOST` is the Floci backing-container name `floci-valkey-cache-3mrai-local-cache-redis`, NEVER `localhost`. `REDIS_PORT` is `6379` (the container port), never the host-side proxy port.
- **Env files are generated, never hand-edited.** All new vars go into `infra/environments/local/scripts/generate_env_files.py`; run `make env-file` to emit them.
- **pnpm only** — never `npm` or `yarn`. Run `nvm use` before any Node command.
- **Fail-open, 50ms timeout, always.** On any Redis error or timeout: fall through to the database, respond `X-Cache: BYPASS`, log WARN `app_event=cache_unavailable` with a machine-readable `reason`. A cache failure must never break or degrade a read. A cache-WRITE failure never affects the response.
- **`X-Cache` values are exactly `HIT`, `MISS`, `BYPASS`.** `HIT` carries `X-Cache-TTL: <seconds remaining>`; `MISS` and `BYPASS` carry no TTL header. Only `200` responses are ever cached.
- **Every key carries both `cognito_sub` and `user_id`**, except `orders:products:v1` (belongs to no user) and `identity:sub-to-user:v1:{cognito_sub}`.
- **Never put a full cache key in a span or a metric dimension.** Keys carry `cognito_sub` and `user_id`; only the prefix (e.g. `orders:cart:v1`) may be exported.
- **Metrics go through each service's existing CloudWatch publisher**, namespace `3MRAI` — NOT through OTel instruments, which no service has. `cache_requests_total` with dimensions `Service`/`KeyPrefix`/`Result`; `cache_operation_duration_ms` with `Service`/`Operation`, unit `Milliseconds`. These publishers must not throw.
- **`CACHE_ENABLED=false` skips the interceptor entirely** and emits no `X-Cache` header at all.
- **Three test layers per cached endpoint** ([[testing]]): unit/integration, internal E2E (direct service URL), and gateway E2E with a real Cognito JWT. The gateway layer is not optional — it is the only layer that proves the header survives API Gateway and nginx.
- **Cross-user isolation is an explicit test**, not an implicit one: user B must never receive user A's cached entry.

---
### Task 1: Wire Redis credentials and the kill switch into every service

Redis exists and Users already reaches it. This task makes Orders and Tracking able to reach it too, adds the `CACHE_ENABLED` kill switch to all three, and installs the two missing client libraries. It ships no caching behavior — its deliverable is "every service can talk to Redis and knows whether caching is on".

**Files:**
- Modify: `infra/environments/local/scripts/generate_env_files.py:316-317` (users block — add `CACHE_ENABLED`), `:344-380` (orders block), `:387-440` (tracking block)
- Modify: `.env.example`
- Modify: `services/orders/src/Orders.Api/Orders.Api.csproj` (add `StackExchange.Redis`)
- Modify: `services/tracking/requirements-runtime.txt` (add `redis`)
- Modify: `services/users/src/shared/config/env.ts:49-50` (add `CACHE_ENABLED`)
- Test: `services/users/tests/shared/env.test.ts`, `services/tracking/tests/test_settings.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: env vars `REDIS_HOST` (string), `REDIS_PORT` (int), `CACHE_ENABLED` (bool) present in `.env.local.users`, `.env.local.orders`, `.env.local.tracking`. Package references `StackExchange.Redis` (Orders) and `redis` (Tracking). Every later task depends on these three vars existing.

- [ ] **Step 1: Add the three vars to the Orders and Tracking generator blocks, and CACHE_ENABLED to Users**

In `infra/environments/local/scripts/generate_env_files.py`, the orders block's `generated={...}` dict (starts at `:347`) gains these entries. Place them right after `"GRPC_API_KEY": GRPC_API_KEY,`:

```python
                # Redis/Valkey for the response cache. REDIS_HOST is the Floci
                # BACKING CONTAINER NAME on the Docker network, never
                # "localhost" — inside the orders container localhost is orders
                # itself. REDIS_PORT is the CONTAINER's port (6379), not the
                # host-side proxy port the ElastiCache API reports. Same values
                # Users already consumes; see the users block above.
                "REDIS_HOST": redis_host,
                "REDIS_PORT": redis_port,
```

and the orders `custom_defaults={...}` dict (`:377-380`) gains:

```python
                # Kill switch for the response cache. In CUSTOM (not generated)
                # so a developer can flip it per-machine without `make env-file`
                # overwriting the choice — and so the load-test A/B can toggle it.
                "CACHE_ENABLED": "true",
```

Apply the identical two additions to the tracking block (`generated={...}` starting `:389`, `custom_defaults={...}` at `:431`). Add ONLY the `custom_defaults` entry to the users block (`:316-317` already has `REDIS_HOST`/`REDIS_PORT`).

- [ ] **Step 2: Regenerate the env files and verify all three carry the vars**

```bash
make env-file
grep -H "REDIS_HOST\|REDIS_PORT\|CACHE_ENABLED" .env.local.users .env.local.orders .env.local.tracking
```

Expected: nine lines total — `REDIS_HOST`, `REDIS_PORT` and `CACHE_ENABLED` in each of the three files. `REDIS_HOST` must read `floci-valkey-cache-3mrai-local-cache-redis` and `REDIS_PORT` must read `6379`. If `REDIS_HOST` says `localhost`, stop: the terraform output is being misread and nothing downstream will connect.

- [ ] **Step 3: Update .env.example to document the new contract**

`.env.example` is the committed contract (`.env*` is otherwise git-ignored). It already documents `REDIS_HOST`/`REDIS_PORT` at `:76-85`. Append below that block:

```bash
# Kill switch for the response cache (docs/shared/conventions/x-cache-response-header.md).
# "false" skips the cache interceptor entirely: no Redis call, and no X-Cache
# header on any response. Present in all three service env files. The load-test
# A/B toggles this to measure the cache's effect.
CACHE_ENABLED=true
```

- [ ] **Step 4: Add the Redis client package to Orders**

```bash
cd services/orders && dotnet add src/Orders.Api/Orders.Api.csproj package StackExchange.Redis --version 2.8.24
```

- [ ] **Step 5: Add the Redis client package to Tracking**

Runtime dependency, so it goes in `requirements-runtime.txt` (not `requirements.txt`), with an exact `==` pin per that file's header rule. Add after the `nanoid==2.0.0` line:

```
redis==5.2.1
```

Then install: `cd services/tracking && pip install -r requirements.txt`

- [ ] **Step 6: Declare CACHE_ENABLED in the Users Zod schema**

In `services/users/src/shared/config/env.ts`, after the `REDIS_PORT` line (`:50`), add — following the exact shape of the existing `E2E_TESTING_ENABLED` boolean at `:5-9`:

```typescript
  CACHE_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
```

- [ ] **Step 7: Declare CACHE_ENABLED in the Tracking settings**

In `services/tracking/src/shared/config/settings.py`, inside `class Settings(BaseSettings)`, after `e2e_testing_enabled: bool = False` (`:155`):

```python
    # Kill switch for the response cache. Defaults to True so a service that
    # never sets it still caches; the load-test A/B flips it to False.
    cache_enabled: bool = True
```

Because it has a default it is NOT required, so it does NOT go into `MINIMAL_ENV` in `tests/test_settings.py`. It DOES go into `MANAGED_KEYS` (`tests/test_settings.py:26`) so the `clean_env` fixture strips it between tests.

- [ ] **Step 8: Write the failing test for the Users env var**

Append to `services/users/tests/shared/env.test.ts`:

```typescript
  it("defaults CACHE_ENABLED to true and coerces the string to a boolean", () => {
    const base = validEnv();
    expect(parseEnv({ ...base }).CACHE_ENABLED).toBe(true);
    expect(parseEnv({ ...base, CACHE_ENABLED: "false" }).CACHE_ENABLED).toBe(false);
    expect(parseEnv({ ...base, CACHE_ENABLED: "true" }).CACHE_ENABLED).toBe(true);
  });
```

(`validEnv()` is the existing helper in that file — reuse it rather than building an env object by hand.)

- [ ] **Step 9: Write the failing test for the Tracking setting**

Append to `services/tracking/tests/test_settings.py`:

```python
class TestCacheEnabled:
    def test_defaults_to_true_when_unset(self) -> None:
        assert build().cache_enabled is True

    def test_reads_false_from_the_environment(self) -> None:
        assert build(CACHE_ENABLED="false").cache_enabled is False
```

(`build(...)` is the existing module-level helper at `:49` that sets real `os.environ` keys and constructs `Settings(_env_file=None)`.)

- [ ] **Step 10: Run both test suites and verify they pass**

```bash
nvm use && pnpm --filter @3mrai/users test -- env.test.ts
cd services/tracking && pytest tests/test_settings.py -v
```

Expected: PASS in both. If the Tracking one fails with a `ValidationError` about an unexpected key, `CACHE_ENABLED` is missing from `MANAGED_KEYS`.

- [ ] **Step 11: Verify Orders and Tracking can actually reach Redis**

This is the task's real deliverable, and the step that catches a wrong `REDIS_HOST` before three tasks are built on it.

```bash
make up
docker compose exec orders getent hosts floci-valkey-cache-3mrai-local-cache-redis
docker compose exec tracking python -c "import redis, os; r = redis.Redis(host=os.environ['REDIS_HOST'], port=int(os.environ['REDIS_PORT']), socket_timeout=2); print(r.ping())"
```

Expected: the first prints an IP and the container name; the second prints `True`. A `ConnectionError` or an empty `getent` means `REDIS_HOST` is wrong — do not proceed to Task 2.

- [ ] **Step 12: Commit**

```bash
git add infra/environments/local/scripts/generate_env_files.py .env.example \
  services/orders/src/Orders.Api/Orders.Api.csproj \
  services/tracking/requirements-runtime.txt services/tracking/src/shared/config/settings.py \
  services/tracking/tests/test_settings.py \
  services/users/src/shared/config/env.ts services/users/tests/shared/env.test.ts
git commit -m "build(infra): give Orders and Tracking Redis access and add the CACHE_ENABLED switch"
```

---
### Task 2: Orders — CacheGateway, the identity cache, and the products cache

Orders goes first because it exercises every hard case: a catalog shared by all users, a volatile per-user cart, and the per-user key index. This task builds the transport plus the simplest cached endpoint (`GET /v1/products`, which belongs to no user and needs no key index). Task 3 adds the per-user endpoints on top.

**Files:**
- Create: `services/orders/src/Orders.Infrastructure/Caching/CacheGateway.cs`, `ICacheGateway.cs`, `CacheKeys.cs`, `CacheOutcome.cs`, `NoopCacheGateway.cs`
- Create: `services/orders/src/Orders.Api/Caching/CachedReadFilter.cs`
- Create: `services/orders/src/Orders.Infrastructure/Identity/CachedUserDirectory.cs`
- Modify: `services/orders/src/Orders.Api/Program.cs` (DI registration + `AddSource`)
- Modify: `services/orders/src/Orders.Api/Endpoints/ProductEndpoints.cs:16-21`
- Test: `services/orders/tests/Orders.Tests/Infrastructure/CacheGatewayTests.cs`, `tests/Orders.Tests/Api/ProductCacheTests.cs`, `tests/Orders.Tests/Identity/CachedUserDirectoryTests.cs`

**Interfaces:**
- Consumes: `REDIS_HOST`, `REDIS_PORT`, `CACHE_ENABLED` from Task 1.
- Produces:
  - `ICacheGateway` with `Task<CacheOutcome<T>> GetAsync<T>(string key, CancellationToken ct)`, `Task SetAsync<T>(string key, T value, TimeSpan ttl, CancellationToken ct)`, `Task InvalidateAsync(IReadOnlyCollection<string> keys, CancellationToken ct)`, `Task TrackKeyAsync(string cognitoSub, string key, CancellationToken ct)`, `Task InvalidateUserKeysAsync(string cognitoSub, CancellationToken ct)`
  - `readonly record struct CacheOutcome<T>(CacheResult Result, T? Value, int TtlRemainingSeconds)` and `enum CacheResult { Hit, Miss, Bypass }`
  - `static class CacheKeys` with `Products`, `Cart(sub, userId)`, `MyOrders(sub, userId, includeTracking)`, `Order(sub, userId, orderId, includeTracking)`, `Identity(sub)`, `UserIndex(sub)` — Task 3 consumes all of them.
  - `CachedReadFilter` + the `.WithCache(...)` extension — Task 3 applies it to three more routes.

- [ ] **Step 1: Write the failing test for CacheGateway's fail-open contract**

This test comes first because fail-open is the design's governing rule, and it is the behavior most likely to be silently broken later. Create `services/orders/tests/Orders.Tests/Infrastructure/CacheGatewayTests.cs`:

```csharp
using System.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using Orders.Infrastructure.Caching;
using StackExchange.Redis;

namespace Orders.Tests.Infrastructure;

public class CacheGatewayTests
{
    private static CacheGateway Gateway(IDatabase db) =>
        new(db, new NoopMetricsPublisher(), NullLogger<CacheGateway>.Instance,
            timeout: TimeSpan.FromMilliseconds(50));

    [Fact]
    public async Task Get_returns_Bypass_when_redis_throws()
    {
        var db = new ThrowingDatabase();
        var outcome = await Gateway(db).GetAsync<string>("orders:products:v1", default);

        Assert.Equal(CacheResult.Bypass, outcome.Result);
        Assert.Null(outcome.Value);
    }

    [Fact]
    public async Task Get_returns_Bypass_when_redis_exceeds_the_timeout()
    {
        var db = new SlowDatabase(TimeSpan.FromMilliseconds(500));
        var sw = Stopwatch.StartNew();

        var outcome = await Gateway(db).GetAsync<string>("orders:products:v1", default);

        sw.Stop();
        Assert.Equal(CacheResult.Bypass, outcome.Result);
        Assert.True(sw.ElapsedMilliseconds < 300,
            $"the 50ms timeout did not fire; the call took {sw.ElapsedMilliseconds}ms");
    }

    [Fact]
    public async Task Set_swallows_a_redis_failure_so_the_response_is_unaffected()
    {
        var db = new ThrowingDatabase();
        // Must not throw: a cache-write failure never affects the response.
        await Gateway(db).SetAsync("orders:products:v1", "v", TimeSpan.FromMinutes(10), default);
    }

    [Fact]
    public async Task Get_returns_Hit_with_the_remaining_ttl()
    {
        var db = new FakeDatabase();
        await Gateway(db).SetAsync("orders:products:v1", "cached", TimeSpan.FromMinutes(10), default);

        var outcome = await Gateway(db).GetAsync<string>("orders:products:v1", default);

        Assert.Equal(CacheResult.Hit, outcome.Result);
        Assert.Equal("cached", outcome.Value);
        Assert.InRange(outcome.TtlRemainingSeconds, 1, 600);
    }

    [Fact]
    public async Task Get_returns_Miss_for_an_absent_key()
    {
        var outcome = await Gateway(new FakeDatabase()).GetAsync<string>("orders:products:v1", default);

        Assert.Equal(CacheResult.Miss, outcome.Result);
        Assert.Null(outcome.Value);
    }
}
```

The three fakes go in the same file. `FakeDatabase` is a `Dictionary`-backed `IDatabase` implementing only `StringGetAsync`, `StringSetAsync`, `KeyTimeToLiveAsync`, `KeyDeleteAsync`, `SetAddAsync`, `SetMembersAsync` and throwing `NotSupportedException` from every other member; `ThrowingDatabase` throws `RedisConnectionException` from all six; `SlowDatabase` awaits its delay first. Write real-shaped fakes rather than a blanket mock — a mock that returns default for everything would let a broken gateway pass.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd services/orders && dotnet test --filter CacheGatewayTests`
Expected: FAIL — `CacheGateway`, `CacheResult` and `CacheOutcome` do not exist yet.

- [ ] **Step 3: Implement CacheOutcome, CacheResult and ICacheGateway**

Create `services/orders/src/Orders.Infrastructure/Caching/CacheOutcome.cs`:

```csharp
namespace Orders.Infrastructure.Caching;

// Three-valued deliberately: Bypass (Redis unavailable) is NOT Miss (Redis
// answered "not there"). Collapsing them would make a Redis outage read as a
// poor hit-rate in the metrics instead of as an outage.
public enum CacheResult { Hit, Miss, Bypass }

public readonly record struct CacheOutcome<T>(CacheResult Result, T? Value, int TtlRemainingSeconds)
{
    public static CacheOutcome<T> Miss() => new(CacheResult.Miss, default, 0);
    public static CacheOutcome<T> Bypass() => new(CacheResult.Bypass, default, 0);
    public static CacheOutcome<T> Hit(T value, int ttlRemaining) =>
        new(CacheResult.Hit, value, ttlRemaining);
}
```

Create `ICacheGateway.cs`:

```csharp
namespace Orders.Infrastructure.Caching;

// Every method is fail-open: it swallows Redis errors and timeouts rather than
// propagating them. The cache may never break or degrade a read.
public interface ICacheGateway
{
    Task<CacheOutcome<T>> GetAsync<T>(string key, CancellationToken ct);
    Task SetAsync<T>(string key, T value, TimeSpan ttl, CancellationToken ct);
    Task InvalidateAsync(IReadOnlyCollection<string> keys, CancellationToken ct);

    // Records `key` in the caller's key index so InvalidateUserKeysAsync can
    // find it later. Needed because keys carry variable suffixes (t0/t1, an
    // order id) that cannot be reconstructed at invalidation time — and because
    // KEYS/SCAN is O(N) over the whole keyspace and unacceptable in production.
    Task TrackKeyAsync(string cognitoSub, string key, CancellationToken ct);
    Task InvalidateUserKeysAsync(string cognitoSub, CancellationToken ct);
}
```

- [ ] **Step 4: Implement CacheGateway**

Create `services/orders/src/Orders.Infrastructure/Caching/CacheGateway.cs`. The load-bearing details: every public method wraps its Redis call in `try/catch` plus a `CancellationTokenSource` timeout; a `GET` reads value and TTL together; metrics and spans are emitted but never allowed to throw.

```csharp
using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;
using StackExchange.Redis;

namespace Orders.Infrastructure.Caching;

public class CacheGateway : ICacheGateway
{
    // Registered on the tracer provider in Program.cs. A new ActivitySource that
    // is NOT added there produces spans that are created and never exported.
    public const string ActivitySourceName = "orders-cache";
    private static readonly ActivitySource Source = new(ActivitySourceName);

    private readonly IDatabase _db;
    private readonly IMetricsPublisher _metrics;
    private readonly ILogger<CacheGateway> _logger;
    private readonly TimeSpan _timeout;

    public CacheGateway(IDatabase db, IMetricsPublisher metrics,
        ILogger<CacheGateway> logger, TimeSpan timeout)
    {
        _db = db;
        _metrics = metrics;
        _logger = logger;
        _timeout = timeout;
    }

    public async Task<CacheOutcome<T>> GetAsync<T>(string key, CancellationToken ct)
    {
        var prefix = CacheKeys.PrefixOf(key);
        using var activity = Source.StartActivity("cache.get", ActivityKind.Client);
        activity?.SetTag("cache.key_prefix", prefix); // NEVER the full key: it carries cognito_sub and user_id
        var sw = Stopwatch.StartNew();

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeout);

            var value = await _db.StringGetAsync(key).WaitAsync(cts.Token);
            if (!value.HasValue)
            {
                await RecordAsync(prefix, CacheResult.Miss, "get", sw, activity, ct);
                return CacheOutcome<T>.Miss();
            }

            var ttl = await _db.KeyTimeToLiveAsync(key).WaitAsync(cts.Token);
            var deserialized = JsonSerializer.Deserialize<T>(value!);
            if (deserialized is null)
            {
                await RecordAsync(prefix, CacheResult.Miss, "get", sw, activity, ct);
                return CacheOutcome<T>.Miss();
            }

            var remaining = (int)Math.Max(0, ttl?.TotalSeconds ?? 0);
            activity?.SetTag("cache.ttl_remaining", remaining);
            await RecordAsync(prefix, CacheResult.Hit, "get", sw, activity, ct);
            return CacheOutcome<T>.Hit(deserialized, remaining);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Includes the timeout (OperationCanceledException from OUR cts, not
            // the caller's) and every Redis/deserialization failure.
            LogUnavailable(ex, prefix, ReasonFor(ex));
            await RecordAsync(prefix, CacheResult.Bypass, "get", sw, activity, ct);
            return CacheOutcome<T>.Bypass();
        }
    }

    public async Task SetAsync<T>(string key, T value, TimeSpan ttl, CancellationToken ct)
    {
        var prefix = CacheKeys.PrefixOf(key);
        using var activity = Source.StartActivity("cache.set", ActivityKind.Client);
        activity?.SetTag("cache.key_prefix", prefix);
        var sw = Stopwatch.StartNew();

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeout);
            await _db.StringSetAsync(key, JsonSerializer.Serialize(value), ttl).WaitAsync(cts.Token);
            await PublishDurationAsync(sw, "set", ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Deliberately swallowed and NOT rethrown: the response is already
            // correct, it just will not be cached.
            LogUnavailable(ex, prefix, ReasonFor(ex));
        }
    }

    public async Task InvalidateAsync(IReadOnlyCollection<string> keys, CancellationToken ct)
    {
        if (keys.Count == 0) return;
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeout);
            await _db.KeyDeleteAsync(keys.Select(k => (RedisKey)k).ToArray()).WaitAsync(cts.Token);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // A failed invalidation is the one failure with a correctness cost:
            // the stale entry survives until its TTL. Logged at WARN so it is
            // visible, but still never propagated into the write's response.
            LogUnavailable(ex, "invalidate", "invalidate_failed");
        }
    }

    public async Task TrackKeyAsync(string cognitoSub, string key, CancellationToken ct)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeout);
            var index = CacheKeys.UserIndex(cognitoSub);
            await _db.SetAddAsync(index, key).WaitAsync(cts.Token);
            // The index must outlive every entry it points at, or invalidation
            // silently misses keys. One hour > the longest response TTL (5 min).
            await _db.KeyExpireAsync(index, TimeSpan.FromHours(1)).WaitAsync(cts.Token);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            LogUnavailable(ex, "index", "track_key_failed");
        }
    }

    public async Task InvalidateUserKeysAsync(string cognitoSub, CancellationToken ct)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeout);
            var index = CacheKeys.UserIndex(cognitoSub);
            var members = await _db.SetMembersAsync(index).WaitAsync(cts.Token);
            if (members.Length > 0)
            {
                await _db.KeyDeleteAsync(members.Select(m => (RedisKey)m.ToString()).ToArray())
                    .WaitAsync(cts.Token);
            }
            await _db.KeyDeleteAsync(index).WaitAsync(cts.Token);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            LogUnavailable(ex, "index", "invalidate_user_keys_failed");
        }
    }

    private static string ReasonFor(Exception ex) =>
        ex is OperationCanceledException ? "cache_timeout" : "redis_error";

    private void LogUnavailable(Exception ex, string prefix, string reason) =>
        _logger.LogWarning(ex,
            "{app_event} key_prefix={key_prefix} reason={reason}",
            "cache_unavailable", prefix, reason);

    private async Task RecordAsync(string prefix, CacheResult result, string operation,
        Stopwatch sw, Activity? activity, CancellationToken ct)
    {
        var label = result.ToString().ToLowerInvariant();
        activity?.SetTag("cache.result", label);
        await _metrics.PublishAsync("cache_requests_total", 1,
            new Dictionary<string, string>
            {
                ["Service"] = "orders",
                ["KeyPrefix"] = prefix,
                ["Result"] = label,
            }, ct);
        await PublishDurationAsync(sw, operation, ct);
    }

    private Task PublishDurationAsync(Stopwatch sw, string operation, CancellationToken ct) =>
        _metrics.PublishAsync("cache_operation_duration_ms", sw.Elapsed.TotalMilliseconds,
            new Dictionary<string, string> { ["Service"] = "orders", ["Operation"] = operation }, ct);
}
```

Also create `NoopCacheGateway.cs` implementing `ICacheGateway` with every method returning `CacheOutcome<T>.Bypass()` / `Task.CompletedTask`. It is what gets registered when `CACHE_ENABLED=false`, and what unit tests inject when they are not exercising the cache — mirroring the existing `NoopMetricsPublisher` / `NoopEventPublisher` pattern.

- [ ] **Step 5: Implement CacheKeys**

Create `services/orders/src/Orders.Infrastructure/Caching/CacheKeys.cs`. Centralizing key construction is what makes cross-user leakage structurally impossible — no caller ever concatenates a key by hand.

```csharp
namespace Orders.Infrastructure.Caching;

public static class CacheKeys
{
    public const string ProductsPrefix = "orders:products:v1";
    public const string CartPrefix = "orders:cart:v1";
    public const string MyOrdersPrefix = "orders:my-orders:v1";
    public const string OrderPrefix = "orders:order:v1";
    public const string IdentityPrefix = "identity:sub-to-user:v1";
    public const string UserIndexPrefix = "orders:index:v1";

    public static readonly TimeSpan ProductsTtl = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan CartTtl = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan OrdersTtl = TimeSpan.FromMinutes(2);
    public static readonly TimeSpan IdentityTtl = TimeSpan.FromHours(1);

    public static string Products => ProductsPrefix;
    public static string Cart(string sub, string userId) => $"{CartPrefix}:{sub}:{userId}";
    public static string MyOrders(string sub, string userId, bool includeTracking) =>
        $"{MyOrdersPrefix}:{sub}:{userId}:t{(includeTracking ? 1 : 0)}";
    public static string Order(string sub, string userId, string orderId, bool includeTracking) =>
        $"{OrderPrefix}:{sub}:{userId}:{orderId}:t{(includeTracking ? 1 : 0)}";
    public static string Identity(string sub) => $"{IdentityPrefix}:{sub}";
    public static string UserIndex(string sub) => $"{UserIndexPrefix}:{sub}";

    // The prefix is the ONLY part of a key that may reach a span attribute or a
    // metric dimension: the rest carries cognito_sub and user_id, and unbounded
    // dimension values would also explode CloudWatch cardinality and cost.
    public static string PrefixOf(string key)
    {
        var parts = key.Split(':');
        return parts.Length >= 3 ? string.Join(':', parts[0], parts[1], parts[2]) : key;
    }
}
```

- [ ] **Step 6: Run the gateway tests and verify they pass**

Run: `cd services/orders && dotnet test --filter CacheGatewayTests`
Expected: PASS, all five.

- [ ] **Step 7: Commit the transport**

```bash
git add services/orders/src/Orders.Infrastructure/Caching services/orders/tests/Orders.Tests/Infrastructure/CacheGatewayTests.cs
git commit -m "feat(orders): add the fail-open Redis cache gateway and key builder"
```

- [ ] **Step 8: Write the failing test for the identity cache**

The identity cache is what keeps the `user_id`-in-every-key decision affordable. Create `services/orders/tests/Orders.Tests/Identity/CachedUserDirectoryTests.cs`:

```csharp
using Orders.Application.Identity;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Identity;

namespace Orders.Tests.Identity;

public class CachedUserDirectoryTests
{
    private sealed class CountingDirectory : IUserDirectory
    {
        public int Calls;
        public Task<string?> ResolveInternalUserIdAsync(string cognitoSub, CancellationToken ct = default)
        { Calls++; return Task.FromResult<string?>("usr_known"); }
        public Task<CallerProfile?> ResolveCallerAsync(string cognitoSub, CancellationToken ct = default)
            => Task.FromResult<CallerProfile?>(null);
    }

    [Fact]
    public async Task Resolves_through_the_inner_directory_on_a_miss_then_serves_from_cache()
    {
        var inner = new CountingDirectory();
        var cache = new FakeCacheGateway();
        var sut = new CachedUserDirectory(inner, cache);

        var first = await sut.ResolveInternalUserIdAsync("sub-known", default);
        var second = await sut.ResolveInternalUserIdAsync("sub-known", default);

        Assert.Equal("usr_known", first);
        Assert.Equal("usr_known", second);
        Assert.Equal(1, inner.Calls); // the second call never reached gRPC
    }

    [Fact]
    public async Task Falls_back_to_the_inner_directory_when_the_cache_bypasses()
    {
        var inner = new CountingDirectory();
        var sut = new CachedUserDirectory(inner, new BypassingCacheGateway());

        var resolved = await sut.ResolveInternalUserIdAsync("sub-known", default);

        Assert.Equal("usr_known", resolved);
        Assert.Equal(1, inner.Calls);
    }

    [Fact]
    public async Task Does_not_cache_an_unresolved_user()
    {
        // A null resolution is not a fact about the user, it is the absence of
        // one. Caching it for an hour would keep a newly-created user unknown.
        var cache = new FakeCacheGateway();
        var sut = new CachedUserDirectory(new NullReturningDirectory(), cache);

        await sut.ResolveInternalUserIdAsync("sub-unknown", default);

        Assert.Empty(cache.Stored);
    }
}
```

`FakeCacheGateway` is a `Dictionary`-backed `ICacheGateway` exposing a `Stored` dictionary; `BypassingCacheGateway` returns `CacheOutcome<T>.Bypass()` from `GetAsync` and no-ops the rest; `NullReturningDirectory` returns `null` from `ResolveInternalUserIdAsync`. Put all three in the same file.

- [ ] **Step 9: Run the test to verify it fails**

Run: `cd services/orders && dotnet test --filter CachedUserDirectoryTests`
Expected: FAIL — `CachedUserDirectory` does not exist.

- [ ] **Step 10: Implement CachedUserDirectory**

A decorator over the existing `IUserDirectory`, so nothing that consumes that interface changes. Create `services/orders/src/Orders.Infrastructure/Identity/CachedUserDirectory.cs`:

```csharp
using Orders.Application.Identity;
using Orders.Infrastructure.Caching;

namespace Orders.Infrastructure.Identity;

// Wraps the gRPC directory with the identity-mapping cache. Sits in front of
// the response cache: every per-user key carries user_id, so this resolution
// runs BEFORE a response key can be built — on hits too. Caching it is what
// keeps a response-cache hit from still paying a gRPC round trip.
public class CachedUserDirectory : IUserDirectory
{
    private readonly IUserDirectory _inner;
    private readonly ICacheGateway _cache;

    public CachedUserDirectory(IUserDirectory inner, ICacheGateway cache)
    {
        _inner = inner;
        _cache = cache;
    }

    public async Task<string?> ResolveInternalUserIdAsync(string cognitoSub, CancellationToken ct = default)
    {
        var key = CacheKeys.Identity(cognitoSub);
        var cached = await _cache.GetAsync<string>(key, ct);
        if (cached.Result == CacheResult.Hit) return cached.Value;

        var resolved = await _inner.ResolveInternalUserIdAsync(cognitoSub, ct);

        // Only a positive resolution is cached. A null means "not found right
        // now", which a 1h TTL would freeze into "not found for an hour".
        if (resolved is not null)
        {
            await _cache.SetAsync(key, resolved, CacheKeys.IdentityTtl, ct);
        }

        return resolved;
    }

    // Deliberately NOT cached: the full profile carries the caller's email and
    // name, and it is only read on the order-creation write path, where the
    // saving would be negligible and the PII exposure in Redis would not.
    public Task<CallerProfile?> ResolveCallerAsync(string cognitoSub, CancellationToken ct = default) =>
        _inner.ResolveCallerAsync(cognitoSub, ct);
}
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `cd services/orders && dotnet test --filter CachedUserDirectoryTests`
Expected: PASS, all three.

- [ ] **Step 12: Write the failing integration test for the products cache**

Create `services/orders/tests/Orders.Tests/Api/ProductCacheTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using Orders.Application.Orders;

namespace Orders.Tests.Api;

[Collection(Orders.Tests.Api.OrdersApiCollection.Name)]
public class ProductCacheTests
{
    private readonly OrdersApiFactory _factory;
    public ProductCacheTests(OrdersApiFactory factory) => _factory = factory;

    private HttpClient Client(string sub)
    {
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", sub);
        return client;
    }

    [Fact]
    public async Task First_read_is_a_MISS_and_the_second_is_a_HIT_with_a_ttl()
    {
        var client = Client(OrdersApiFactory.KnownCognitoSub);

        var first = await client.GetAsync("/v1/products");
        var second = await client.GetAsync("/v1/products");

        Assert.Equal("MISS", first.Headers.GetValues("X-Cache").Single());
        Assert.False(first.Headers.Contains("X-Cache-TTL"));

        Assert.Equal("HIT", second.Headers.GetValues("X-Cache").Single());
        var ttl = int.Parse(second.Headers.GetValues("X-Cache-TTL").Single());
        Assert.InRange(ttl, 1, 600);
    }

    [Fact]
    public async Task A_hit_returns_the_same_body_as_the_miss()
    {
        var client = Client(OrdersApiFactory.KnownCognitoSub);

        var miss = await client.GetFromJsonAsync<List<ProductDto>>("/v1/products");
        var hit = await client.GetFromJsonAsync<List<ProductDto>>("/v1/products");

        Assert.NotNull(miss);
        Assert.Equal(miss!.Count, hit!.Count);
        Assert.Equal(miss.Select(p => p.Id), hit.Select(p => p.Id));
        Assert.Equal(miss.Single(p => p.Id == _factory.SeededProductId).UnitPrice.Cents,
                     hit.Single(p => p.Id == _factory.SeededProductId).UnitPrice.Cents);
    }

    [Fact]
    public async Task An_unauthenticated_request_is_401_and_carries_no_cache_header()
    {
        // The 401 short-circuits in CallerContextMiddleware, before routing —
        // so the filter never runs and must not have stamped a header.
        var resp = await _factory.CreateClient().GetAsync("/v1/products");

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
        Assert.False(resp.Headers.Contains("X-Cache"));
    }
}
```

- [ ] **Step 13: Run it to verify it fails**

Run: `cd services/orders && dotnet test --filter ProductCacheTests`
Expected: FAIL — no `X-Cache` header exists yet; `GetValues` throws `InvalidOperationException`.

- [ ] **Step 14: Implement the CachedReadFilter**

Note on the choice: `HttpErrorMetricsMiddleware.cs:10-14` documents that middleware was chosen over an endpoint filter *because a filter misses short-circuited responses*. That reasoning does not apply here and in fact argues FOR a filter: this cache must only ever wrap the handler, and must NOT stamp a header on a 401 produced by `CallerContextMiddleware` before routing. A filter runs inside the endpoint, which is exactly the scope wanted.

Create `services/orders/src/Orders.Api/Caching/CachedReadFilter.cs`:

```csharp
using Orders.Api.Identity;
using Orders.Infrastructure.Caching;

namespace Orders.Api.Caching;

// Builds the cache key for THIS request. Returns null to skip caching (e.g. the
// caller's user_id could not be resolved), which yields a normal uncached
// response rather than a wrong or cross-user one.
public delegate Task<string?> CacheKeyBuilder(EndpointFilterInvocationContext ctx, ICurrentCaller caller);

public sealed class CachedReadFilter : IEndpointFilter
{
    private readonly CacheKeyBuilder _keyBuilder;
    private readonly TimeSpan _ttl;

    public CachedReadFilter(CacheKeyBuilder keyBuilder, TimeSpan ttl)
    {
        _keyBuilder = keyBuilder;
        _ttl = ttl;
    }

    public async ValueTask<object?> InvokeAsync(
        EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var http = ctx.HttpContext;
        var cache = http.RequestServices.GetService<ICacheGateway>();
        var caller = http.RequestServices.GetRequiredService<ICurrentCaller>();
        var ct = http.RequestAborted;

        // No gateway registered => CACHE_ENABLED=false. Skip entirely and emit
        // no header at all, per the kill-switch contract.
        if (cache is null) return await next(ctx);

        var key = await _keyBuilder(ctx, caller);
        if (key is null) return await next(ctx);

        // Cached as raw JSON, never as a typed value. See the note below.
        var cached = await cache.GetAsync<string>(key, ct);
        if (cached.Result == CacheResult.Hit && cached.Value is not null)
        {
            http.Response.Headers["X-Cache"] = "HIT";
            http.Response.Headers["X-Cache-TTL"] = cached.TtlRemainingSeconds.ToString();
            // Replay the stored bytes verbatim: the handler never runs, and the
            // body is byte-identical to the MISS that produced it.
            return Results.Content(cached.Value, "application/json");
        }

        http.Response.Headers["X-Cache"] = cached.Result == CacheResult.Bypass ? "BYPASS" : "MISS";

        var result = await next(ctx);

        // Only a 200 is cacheable. IValueHttpResult (NON-generic) is the shared
        // interface every Results.Ok<T> implements regardless of its T, which is
        // what lets one filter serve a route returning two different shapes.
        if (cached.Result != CacheResult.Bypass
            && result is IStatusCodeHttpResult { StatusCode: StatusCodes.Status200OK }
            && result is IValueHttpResult { Value: { } value })
        {
            await cache.SetAsync(key, JsonSerializer.Serialize(value), _ttl, ct);
            if (caller.CognitoSub is { Length: > 0 } sub && !key.StartsWith(CacheKeys.ProductsPrefix))
            {
                // Per-user keys join the caller's index so a later write can
                // invalidate them without KEYS/SCAN. The catalog is excluded:
                // it belongs to no user.
                await cache.TrackKeyAsync(sub, key, ct);
            }
        }

        return result;
    }
}

public static class CachedReadFilterExtensions
{
    public static RouteHandlerBuilder WithCache(
        this RouteHandlerBuilder builder, CacheKeyBuilder keyBuilder, TimeSpan ttl) =>
        builder.AddEndpointFilter(new CachedReadFilter(keyBuilder, ttl));
}
```

> **Note — why the filter is NOT generic, and why it stores raw JSON.**
> `GET /v1/orders/my-orders` returns `Results.Ok(orders)` (an `Ok<IReadOnlyList<OrderDto>>`) when
> `includeTracking=false` and `Results.Ok(...)` over an `OrderWithTrackingDto[]` when it is true —
> **two different generic result types from one route** (`OrderEndpoints.cs:24-59`, and the same
> pattern at `:61-92`). A `CachedReadFilter<T>` matching on `IValueHttpResult<T>` would match only
> one of them, so the other would never be cached: a silent permanent MISS, with every test that
> only checks the `includeTracking=true` path still passing. `IValueHttpResult<T>` is not covariant
> in `T`, so `T = object` does not rescue it either.
> Matching the NON-generic `IValueHttpResult` and storing pre-serialized JSON avoids the problem
> entirely, and has a second benefit: a HIT replays the exact bytes of the MISS, so the two
> responses cannot drift through a serializer-settings difference.

- [ ] **Step 15: Apply the filter to GET /v1/products and register the DI**

In `services/orders/src/Orders.Api/Endpoints/ProductEndpoints.cs`, extend the existing chain (`:16-21`) with the cache filter — the handler and every `.Produces` stay as they are:

```csharp
        group.MapGet("", async (ProductReadService reads) =>
            Results.Ok(await reads.GetProductsAsync()))
            .WithName("GetProducts")
            .WithSummary("List the active product catalog.")
            .Produces<IReadOnlyList<ProductDto>>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status401Unauthorized)
            .WithCache(
                // The catalog belongs to no user: one key for everyone, and the
                // only key in the service with neither cognito_sub nor user_id.
                (_, _) => Task.FromResult<string?>(CacheKeys.Products),
                CacheKeys.ProductsTtl);
```

In `services/orders/src/Orders.Api/Program.cs`, add the cache registrations right after the `IUserDirectory` registration (`:205-206`), and decorate it:

```csharp
// Response cache. When CACHE_ENABLED=false nothing is registered, so
// CachedReadFilter resolves ICacheGateway as null and skips itself entirely.
var cacheEnabled = builder.Configuration.GetValue("CACHE_ENABLED", true);
if (cacheEnabled)
{
    var redisHost = builder.Configuration["REDIS_HOST"]
        ?? (isDocumentGeneration ? "localhost" : throw new InvalidOperationException(
            "REDIS_HOST is not set. It is generated into .env.local.orders by "
            + "`make env-file`; see docs/shared/conventions/env-files.md."));
    var redisPort = builder.Configuration.GetValue("REDIS_PORT", 6379);

    builder.Services.AddSingleton<IConnectionMultiplexer>(_ =>
        ConnectionMultiplexer.Connect(new ConfigurationOptions
        {
            EndPoints = { { redisHost, redisPort } },
            AbortOnConnectFail = false, // a cold Redis must not stop the service booting
            ConnectTimeout = 1000,
        }));
    builder.Services.AddSingleton<ICacheGateway>(sp => new CacheGateway(
        sp.GetRequiredService<IConnectionMultiplexer>().GetDatabase(),
        sp.GetRequiredService<IMetricsPublisher>(),
        sp.GetRequiredService<ILogger<CacheGateway>>(),
        TimeSpan.FromMilliseconds(50)));

    // Decorate the gRPC directory with the identity cache. Registered AFTER the
    // IUserDirectory registration above, so this factory wins.
    builder.Services.AddScoped<IUserDirectory>(sp => new CachedUserDirectory(
        new UserDirectoryGrpcClient(sp.GetRequiredService<Users.V1.Users.UsersClient>(), grpcApiKey),
        sp.GetRequiredService<ICacheGateway>()));
}
```

And register the new ActivitySource in the tracing block (`Program.cs:61-70`) — a source missing from here produces spans that are created and silently never exported:

```csharp
        .AddSource(CacheGateway.ActivitySourceName)
```

- [ ] **Step 16: Give the test factory a Redis endpoint**

`OrdersApiFactory.ConfigureWebHost` supplies config via `UseSetting` (`:84-97`). The integration tests need a real Redis; add a Testcontainers Redis alongside the MySQL one, mirroring `_mysql`:

```csharp
    private readonly RedisContainer _redis = new RedisBuilder("redis:7-alpine").Build();
```

start it in `InitializeAsync`, dispose it in `DisposeAsync`, and add to `ConfigureWebHost`:

```csharp
        builder.UseSetting("REDIS_HOST", _redis.Hostname);
        builder.UseSetting("REDIS_PORT", _redis.GetMappedPublicPort(6379).ToString());
        builder.UseSetting("CACHE_ENABLED", "true");
```

This needs the `Testcontainers.Redis` package: `dotnet add tests/Orders.Tests/Orders.Tests.csproj package Testcontainers.Redis --version 4.13.0`.

Note: `OrdersApiFactory` is a **collection fixture** shared by every test in the collection, so the cache persists across test classes. `ProductCacheTests.First_read_is_a_MISS...` therefore depends on running before anything else warms `orders:products:v1`. Make it deterministic instead — add a flush helper to the factory and call it at the start of each cache test:

```csharp
    public async Task FlushCacheAsync()
    {
        var mux = await ConnectionMultiplexer.ConnectAsync($"{_redis.Hostname}:{_redis.GetMappedPublicPort(6379)},allowAdmin=true");
        await mux.GetServer(mux.GetEndPoints().Single()).FlushDatabaseAsync();
    }
```

- [ ] **Step 17: Run the products cache tests and verify they pass**

Run: `cd services/orders && dotnet test --filter ProductCacheTests`
Expected: PASS, all three.

- [ ] **Step 18: Regenerate the OpenAPI spec**

`services/orders/CLAUDE.md:43-92` makes this a GOLDEN RULE: `dotnet build` reboots `Program` through `GetDocument.Insider` to emit `openapi.yaml`, and the committed file must match. The `isDocumentGeneration` escape added in Step 15 is what keeps that build working without a `REDIS_HOST`.

```bash
cd services/orders && dotnet build
git diff --stat services/orders/openapi.yaml
```

Expected: the build succeeds. If it fails with "REDIS_HOST is not set", the escape hatch in Step 15 is missing or misplaced.

- [ ] **Step 19: Run the full Orders suite to check for regressions**

Run: `cd services/orders && dotnet test`
Expected: PASS. Watch specifically for `CartCheckoutTests` and `ProductEndpointsTests` — the first cached endpoint must not have changed any existing response body.

- [ ] **Step 20: Commit**

```bash
git add services/orders tests
git commit -m "feat(orders): cache the product catalog behind an X-Cache endpoint filter"
```

---
### Task 3: Orders — the per-user endpoints and write-path invalidation

Task 2 built the caching plumbing (`ICacheGateway`, `CacheGateway`, `CacheKeys`,
`CachedReadFilter`/`.WithCache(…)`, `CachedUserDirectory`) and used it to cache the one
user-independent read, `GET /v1/products` (key `orders:products:v1`). Task 3 caches the three
**per-user** reads — `GET /v1/cart`, `GET /v1/orders/my-orders`, `GET /v1/orders/{orderId}` —
and wires **explicit invalidation** into every write path that can make those entries stale.

Three things make this task harder than Task 2 and each gets its own step below:

1. **Two shapes behind one route.** `GET /v1/orders/my-orders` returns a bare
   `IReadOnlyList<OrderDto>` when `includeTracking=false` and an `OrderWithTrackingDto[]` when
   `true` (`OrderEndpoints.cs:36-49`) — concretely, `Results.Ok(orders)` produces
   `Ok<IReadOnlyList<OrderDto>>` on one branch and `Ok<OrderWithTrackingDto[]>` on the other,
   two different generic result types from one route. `GET /v1/orders/{orderId}` does the same
   with `OrderDto` vs `OrderWithTrackingDto` (`OrderEndpoints.cs:75-84`).

   **Task 2's filter is non-generic precisely because of this route.** `CachedReadFilter` (no
   `<T>`) matches the non-generic `IValueHttpResult` plus
   `IStatusCodeHttpResult { StatusCode: 200 }`, stores `JsonSerializer.Serialize(value)`, and
   replays a hit as `Results.Content(cachedJson, "application/json")` — raw JSON in, raw JSON
   out, no typed round trip. A generic filter could not have served this route under any type
   argument: `IValueHttpResult<T>` is **not covariant in `T`**, so even
   `CachedReadFilter<object>` would have matched neither `Ok<IReadOnlyList<OrderDto>>` nor
   `Ok<OrderWithTrackingDto[]>`, and both routes would have silently never cached — no error,
   no header, just a permanent MISS. What keeps the two shapes in **separate entries** is the
   `t0`/`t1` segment in `CacheKeys.MyOrders`/`CacheKeys.Order`, which Step 3's key builder
   drives from the query string.
2. **`ResolvedInternalUserId` can legitimately be null.** `CallerContextMiddleware:39-43`
   stamps it on every authenticated request, but `StampInternalUserIdAsync:74-86` **swallows
   every non-cancellation exception** — Users being down leaves an authenticated caller with a
   null internal id. A key built anyway would read `orders:cart:v1:sub-x:` (or worse,
   `…:null`), which is a *shared* key across every unresolvable caller: a cross-user leak. The
   builders return `null` (skip caching) instead (Step 3).
3. **Invalidation goes strictly after the commit**, never before, per the spec's Invalidation
   section — invalidating first lets a concurrent read repopulate the stale value in the window
   between the delete and the commit.

**Files:**

- Create: `services/orders/src/Orders.Api/Caching/UserCacheKeyBuilders.cs`
- Create: `services/orders/src/Orders.Application/Abstractions/ICacheInvalidator.cs`
- Create: `services/orders/src/Orders.Infrastructure/Caching/CacheInvalidator.cs`
- Modify: `services/orders/src/Orders.Api/Endpoints/CartEndpoints.cs`
- Modify: `services/orders/src/Orders.Api/Endpoints/OrderEndpoints.cs`
- Modify: `services/orders/src/Orders.Api/Endpoints/E2eEndpoints.cs`
- Modify: `services/orders/src/Orders.Infrastructure/Carts/CartWriteService.cs`
- Modify: `services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs`
- Modify: `services/orders/src/Orders.Api/Program.cs`
- Modify: `services/orders/openapi.yaml` (regenerated by `dotnet build`, never hand-edited)
- Test: `services/orders/tests/Orders.Tests/Api/CartCacheTests.cs` (new)
- Test: `services/orders/tests/Orders.Tests/Api/OrderCacheTests.cs` (new)
- Test: `services/orders/tests/Orders.Tests/Api/CacheKeyBuilderTests.cs` (new)
- Test: `services/orders/tests/Orders.Tests/Api/CacheCrossUserTests.cs` (new)

**Interfaces:**

*Consumes* (all built in Task 2, exact signatures — do not re-derive):

```csharp
// Orders.Application/Abstractions/ICacheGateway.cs
public interface ICacheGateway
{
    Task<CacheOutcome<T>> GetAsync<T>(string key, CancellationToken ct);
    Task SetAsync<T>(string key, T value, TimeSpan ttl, CancellationToken ct);
    Task InvalidateAsync(IReadOnlyCollection<string> keys, CancellationToken ct);
    Task TrackKeyAsync(string cognitoSub, string key, CancellationToken ct);
    Task InvalidateUserKeysAsync(string cognitoSub, CancellationToken ct);
}

public readonly record struct CacheOutcome<T>(CacheResult Result, T? Value, int TtlRemainingSeconds);
public enum CacheResult { Hit, Miss, Bypass }

// Orders.Application/Abstractions/CacheKeys.cs
public static class CacheKeys
{
    public static string Products();                                   // "orders:products:v1"
    public static string Cart(string sub, string userId);
    public static string MyOrders(string sub, string userId, bool includeTracking);
    public static string Order(string sub, string userId, string orderId, bool includeTracking);
    public static string UserIndex(string sub);
    public static readonly TimeSpan CartTtl;                           // 60s
    public static readonly TimeSpan OrdersTtl;                         // 2min
}

// Orders.Api/Caching/CachedReadFilter.cs
public delegate Task<string?> CacheKeyBuilder(
    EndpointFilterInvocationContext ctx, ICurrentCaller caller);

// NON-generic — there is no type argument anywhere in this API. On a MISS it matches the
// non-generic IValueHttpResult + IStatusCodeHttpResult { StatusCode: 200 } and stores
// JsonSerializer.Serialize(value); on a HIT it returns
// Results.Content(cachedJson, "application/json"), replaying the stored bytes verbatim.
// Every cached read therefore reads through cache.GetAsync<string>(key, ct) — the stored
// value is always a JSON string, whatever shape the handler returned.
public sealed class CachedReadFilter : IEndpointFilter { /* … */ }

public static class CachedReadExtensions
{
    public static RouteHandlerBuilder WithCache(
        this RouteHandlerBuilder builder, CacheKeyBuilder keyBuilder, TimeSpan ttl);
}
```

`ICurrentCaller` (`services/orders/src/Orders.Api/Identity/ICurrentCaller.cs:6-19`):
`string? CognitoSub`, `string? ResolvedInternalUserId` (non-triggering), `void SetSub(string)`,
`Task<string> ResolveInternalUserIdAsync(CancellationToken ct)`.

*Produces:*

```csharp
// Orders.Api/Caching/UserCacheKeyBuilders.cs
public static class UserCacheKeyBuilders
{
    public static Task<string?> Cart(EndpointFilterInvocationContext ctx, ICurrentCaller caller);
    public static Task<string?> MyOrders(EndpointFilterInvocationContext ctx, ICurrentCaller caller);
    public static Task<string?> OrderById(EndpointFilterInvocationContext ctx, ICurrentCaller caller);
}

// Orders.Application/Abstractions/ICacheInvalidator.cs
public interface ICacheInvalidator
{
    Task InvalidateCartAsync(string cognitoSub, CancellationToken ct);
    Task InvalidateOrderCreationAsync(string cognitoSub, CancellationToken ct);
    Task InvalidateProductsAsync(CancellationToken ct);
}
```

---

- [ ] **Step 1: Write the failing test for the key builders' null-identity guard.**

  Create `services/orders/tests/Orders.Tests/Api/CacheKeyBuilderTests.cs`. This is a pure unit
  test over `UserCacheKeyBuilders` — no HTTP, no fixture, no Redis — so it needs no collection
  attribute.

  ```csharp
  using Microsoft.AspNetCore.Http;
  using Orders.Api.Caching;
  using Orders.Api.Identity;
  using Xunit;

  namespace Orders.Tests.Api;

  public class CacheKeyBuilderTests
  {
      // CallerContextMiddleware.StampInternalUserIdAsync (Middleware/CallerContextMiddleware.cs:74-86)
      // swallows EVERY non-cancellation failure, so an authenticated caller can reach a
      // handler with CognitoSub set and ResolvedInternalUserId still null (Users down, an
      // unknown sub, a gRPC deadline). Building a key anyway would produce one key with an
      // empty user_id segment SHARED by every unresolvable caller — a cross-user leak. The
      // builder must decline instead: returning null tells CachedReadFilter to skip caching
      // this request entirely.
      private sealed class FakeCaller : ICurrentCaller
      {
          public string? CognitoSub { get; private set; }
          public string? ResolvedInternalUserId { get; init; }
          public void SetSub(string sub) => CognitoSub = sub;
          public Task<string> ResolveInternalUserIdAsync(CancellationToken ct) =>
              throw new InvalidOperationException(
                  "The key builders must never trigger resolution: they run on the hit path.");
      }

      private static EndpointFilterInvocationContext ContextFor(string? queryString = null)
      {
          var http = new DefaultHttpContext();
          http.Request.QueryString = new QueryString(queryString ?? string.Empty);
          return EndpointFilterInvocationContext.Create(http);
      }

      [Fact]
      public async Task Cart_key_is_null_when_the_internal_user_id_is_unresolved()
      {
          var caller = new FakeCaller { ResolvedInternalUserId = null };
          caller.SetSub("sub-known");

          Assert.Null(await UserCacheKeyBuilders.Cart(ContextFor(), caller));
      }

      [Fact]
      public async Task MyOrders_key_is_null_when_the_internal_user_id_is_unresolved()
      {
          var caller = new FakeCaller { ResolvedInternalUserId = null };
          caller.SetSub("sub-known");

          Assert.Null(await UserCacheKeyBuilders.MyOrders(ContextFor(), caller));
      }

      [Fact]
      public async Task Cart_key_is_built_when_both_identifiers_are_present()
      {
          var caller = new FakeCaller { ResolvedInternalUserId = "usr_known" };
          caller.SetSub("sub-known");

          Assert.Equal(
              CacheKeys.Cart("sub-known", "usr_known"),
              await UserCacheKeyBuilders.Cart(ContextFor(), caller));
      }

      // includeTracking is a QUERY-bound bool defaulting to false (OrderEndpoints.cs:28 and
      // :66). The filter runs before model binding has produced the handler's parameters, so
      // the builder reads the raw query string rather than the bound argument — and it must
      // agree with ASP.NET's binder about what counts as true.
      [Theory]
      [InlineData("", false)]
      [InlineData("?includeTracking=false", false)]
      [InlineData("?includeTracking=true", true)]
      [InlineData("?includeTracking=TRUE", true)]
      public async Task MyOrders_key_varies_with_includeTracking(string query, bool expected)
      {
          var caller = new FakeCaller { ResolvedInternalUserId = "usr_known" };
          caller.SetSub("sub-known");

          Assert.Equal(
              CacheKeys.MyOrders("sub-known", "usr_known", expected),
              await UserCacheKeyBuilders.MyOrders(ContextFor(query), caller));
      }
  }
  ```

- [ ] **Step 2: Run the test and confirm it fails to compile.**

  Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CacheKeyBuilderTests`

  Expected: a **compilation** failure, not an assertion failure —
  `error CS0103: The name 'UserCacheKeyBuilders' does not exist in the current context`
  (repeated per usage). The type does not exist yet. Do not proceed until you see that exact
  error class; an assertion failure here would mean the file was created early.

- [ ] **Step 3: Implement `UserCacheKeyBuilders`.**

  Create `services/orders/src/Orders.Api/Caching/UserCacheKeyBuilders.cs`:

  ```csharp
  using Orders.Api.Identity;
  using Orders.Application.Abstractions;

  namespace Orders.Api.Caching;

  /// <summary>
  /// The <see cref="CacheKeyBuilder"/> implementations for the three per-user reads.
  /// </summary>
  /// <remarks>
  /// <para>
  /// Every one of them returns <c>null</c> — "do not cache this request" — when either
  /// identifier is missing. That is not defensive padding: <c>CallerContextMiddleware</c>
  /// stamps the internal id on every authenticated request
  /// (<c>Middleware/CallerContextMiddleware.cs:39-43</c>) but deliberately SWALLOWS every
  /// non-cancellation failure while doing so (<c>:74-86</c>), so Users being down leaves a
  /// perfectly authenticated caller with a null <c>ResolvedInternalUserId</c>. Building a key
  /// anyway would put an empty segment where <c>user_id</c> belongs — and every unresolvable
  /// caller would then share that ONE key. Declining costs a cache miss; not declining serves
  /// one user's cart to another.
  /// </para>
  /// <para>
  /// None of these calls <c>ResolveInternalUserIdAsync</c>. They run on the HIT path, where
  /// the entire point is to avoid the network; a resolving key builder would reintroduce the
  /// gRPC call the cache exists to remove. <c>ResolvedInternalUserId</c> is the non-triggering
  /// view for exactly this (see its doc comment, <c>Identity/ICurrentCaller.cs:10-15</c>).
  /// </para>
  /// </remarks>
  public static class UserCacheKeyBuilders
  {
      public static Task<string?> Cart(EndpointFilterInvocationContext ctx, ICurrentCaller caller)
      {
          var (sub, userId) = Identity(caller);
          return Task.FromResult(sub is null || userId is null
              ? null
              : CacheKeys.Cart(sub, userId));
      }

      public static Task<string?> MyOrders(EndpointFilterInvocationContext ctx, ICurrentCaller caller)
      {
          var (sub, userId) = Identity(caller);
          return Task.FromResult(sub is null || userId is null
              ? null
              : CacheKeys.MyOrders(sub, userId, IncludeTracking(ctx)));
      }

      public static Task<string?> OrderById(EndpointFilterInvocationContext ctx, ICurrentCaller caller)
      {
          var (sub, userId) = Identity(caller);
          if (sub is null || userId is null)
          {
              return Task.FromResult<string?>(null);
          }

          // Read from the ROUTE VALUES, not from ctx.GetArgument<string>(0): the filter runs
          // ahead of the handler, and relying on an argument's positional index would break
          // silently the next time a parameter is inserted before it.
          var orderId = ctx.HttpContext.Request.RouteValues["orderId"] as string;
          return Task.FromResult(string.IsNullOrEmpty(orderId)
              ? null
              : CacheKeys.Order(sub, userId, orderId, IncludeTracking(ctx)));
      }

      private static (string? Sub, string? UserId) Identity(ICurrentCaller caller) =>
          (caller.CognitoSub, caller.ResolvedInternalUserId);

      /// <summary>
      /// Reads the <c>includeTracking</c> query parameter the way ASP.NET's binder does.
      /// </summary>
      /// <remarks>
      /// The handler declares it as <c>bool includeTracking = false</c>
      /// (<c>OrderEndpoints.cs:28</c>, <c>:66</c>), which the binder fills from the query
      /// string via <c>bool.TryParse</c> — case-insensitive, defaulting to false when absent
      /// or unparseable. Parsing it the same way here is what keeps the KEY and the BODY in
      /// agreement: a mismatch would file the tracking-bearing response under the <c>t0</c>
      /// key and serve it to a caller who asked for the bare shape.
      /// </remarks>
      private static bool IncludeTracking(EndpointFilterInvocationContext ctx) =>
          bool.TryParse(ctx.HttpContext.Request.Query["includeTracking"], out var value) && value;
  }
  ```

- [ ] **Step 4: Run the test and confirm it passes.**

  Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CacheKeyBuilderTests`

  Expected: `Passed! - Failed: 0, Passed: 7` (2 null-guard facts + 1 happy-path fact + 4
  `Theory` cases).

- [ ] **Step 5: Commit the key builders.**

  Run:
  ```
  cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga
  git add services/orders/src/Orders.Api/Caching/UserCacheKeyBuilders.cs \
          services/orders/tests/Orders.Tests/Api/CacheKeyBuilderTests.cs
  git commit -m "feat(orders): cache key builders for the per-user reads"
  ```

  Expected: one commit with 2 files changed.

  > **Note:** per the repo's git policy (`CLAUDE.md` → Working rules → Git), the main session
  > must present the A/B/C/D/E confirmation menu via `AskUserQuestion` before any commit. If
  > you are an implementer agent (`orders-impl`), do **not** run git at all — leave the work in
  > the working tree and let the main session commit. Every "commit" step in this task carries
  > that same caveat; it is stated once here.

- [ ] **Step 6: Write the failing cart cache test — MISS, then HIT, then a PUT returns it to MISS.**

  Create `services/orders/tests/Orders.Tests/Api/CartCacheTests.cs`. `OrdersApiFactory` is a
  **collection** fixture shared with `CartEndpointsTests`, `CreateOrderEndpointTests` and the
  rest of `OrdersApiCollection`, so its Redis carries whatever they left behind — every test
  here starts with `FlushCacheAsync()` (added to the factory in Task 2).

  ```csharp
  using System.Net;
  using System.Net.Http.Json;
  using Xunit;

  namespace Orders.Tests.Api;

  [Collection(OrdersApiCollection.Name)]
  public class CartCacheTests
  {
      private readonly OrdersApiFactory _factory;

      public CartCacheTests(OrdersApiFactory factory) => _factory = factory;

      private HttpClient Client(string sub)
      {
          var client = _factory.CreateClient();
          client.DefaultRequestHeaders.Add("x-user-id", sub);
          return client;
      }

      private static string? CacheHeader(HttpResponseMessage response) =>
          response.Headers.TryGetValues("X-Cache", out var values)
              ? values.FirstOrDefault()
              : null;

      [Fact]
      public async Task Second_cart_read_is_a_hit_and_a_put_returns_it_to_a_miss()
      {
          // The factory's Redis is a COLLECTION fixture shared with every other class in
          // OrdersApiCollection. Without this flush, an entry another class left behind
          // decides whether the first read below is a MISS.
          await _factory.FlushCacheAsync();

          // KnownCognitoSub is the only sub the stub IUserDirectory resolves
          // (OrdersApiFactory:127-128), and an unresolved sub leaves
          // ResolvedInternalUserId null — which makes the key builder decline and nothing
          // is cached at all. This test needs a caller the cache will actually key on.
          var client = Client(OrdersApiFactory.KnownCognitoSub);

          var first = await client.GetAsync("/v1/cart");
          Assert.Equal(HttpStatusCode.OK, first.StatusCode);
          Assert.Equal("MISS", CacheHeader(first));
          // MISS carries no TTL header — only HIT does (spec: Header contract).
          Assert.False(first.Headers.Contains("X-Cache-TTL"));

          var second = await client.GetAsync("/v1/cart");
          Assert.Equal("HIT", CacheHeader(second));
          Assert.True(second.Headers.Contains("X-Cache-TTL"));
          var ttl = int.Parse(second.Headers.GetValues("X-Cache-TTL").First());
          Assert.InRange(ttl, 1, 60); // CacheKeys.CartTtl is 60s.

          // The write in between must invalidate.
          var put = await client.PutAsJsonAsync("/v1/cart", new
          {
              items = new[] { new { productId = _factory.SeededProductId, quantity = 1 } },
          });
          Assert.Equal(HttpStatusCode.OK, put.StatusCode);

          var third = await client.GetAsync("/v1/cart");
          Assert.Equal("MISS", CacheHeader(third));

          // And the body must be the NEW cart, not the emptied one that was cached.
          var body = await third.Content.ReadFromJsonAsync<JsonElement>();
          Assert.Single(body.GetProperty("items").EnumerateArray());
      }

      [Fact]
      public async Task Delete_cart_invalidates_the_cached_cart()
      {
          await _factory.FlushCacheAsync();
          var client = Client(OrdersApiFactory.KnownCognitoSub);

          await client.PutAsJsonAsync("/v1/cart", new
          {
              items = new[] { new { productId = _factory.SeededProductId, quantity = 2 } },
          });

          Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/cart")));
          Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/cart")));

          var deleted = await client.DeleteAsync("/v1/cart");
          Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);

          var after = await client.GetAsync("/v1/cart");
          Assert.Equal("MISS", CacheHeader(after));
          var body = await after.Content.ReadFromJsonAsync<JsonElement>();
          // The cart is gone: GET always answers 200 with the empty shape, never a 404.
          Assert.Empty(body.GetProperty("items").EnumerateArray());
      }
  }
  ```

  Add `using System.Text.Json;` at the top for `JsonElement`.

- [ ] **Step 7: Run the cart cache test and confirm it fails.**

  Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CartCacheTests`

  Expected: **both facts fail** with
  `Assert.Equal() Failure: Values differ — Expected: "MISS", Actual: (null)`. The route is not
  yet wrapped in `.WithCache(…)`, so no `X-Cache` header is emitted at all. A failure reading
  `Expected: "MISS", Actual: "HIT"` would mean the flush is not working; investigate that
  before continuing.

- [ ] **Step 8: Apply `.WithCache` to the three per-user read routes.**

  In `services/orders/src/Orders.Api/Endpoints/CartEndpoints.cs`, append to the `MapGet("")`
  chain (currently ending at `.Produces(StatusCodes.Status401Unauthorized);`, line 36):

  ```csharp
          .Produces<CartDto>(StatusCodes.Status200OK)
          .Produces(StatusCodes.Status401Unauthorized)
          // 60s TTL is only the safety net; correctness comes from the invalidation on
          // every cart PUT/DELETE and on order creation (spec: Cache keys and TTLs).
          //
          // No type argument: CachedReadFilter is non-generic and stores the serialized
          // body, so the call site never names the DTO. .Produces<CartDto> above still
          // documents the shape for OpenAPI — that is unrelated to the cache.
          .WithCache(UserCacheKeyBuilders.Cart, CacheKeys.CartTtl);
  ```

  Add `using Orders.Api.Caching;` and `using Orders.Application.Abstractions;` to the file's
  usings.

  In `services/orders/src/Orders.Api/Endpoints/OrderEndpoints.cs`, append to the
  `MapGet("/my-orders")` chain (currently ending line 59) and the `MapGet("/{orderId}")` chain
  (currently ending line 92):

  ```csharp
          .Produces<IReadOnlyList<OrderWithTrackingDto>>(StatusCodes.Status200OK)
          .Produces(StatusCodes.Status401Unauthorized)
          // No type argument — CachedReadFilter is non-generic, and THIS route is why.
          // It returns two shapes behind one URL: Ok<IReadOnlyList<OrderDto>> when
          // includeTracking is false (:36-39) and Ok<OrderWithTrackingDto[]> when it is
          // true (:46-49). A generic filter could not have matched both, and could not
          // have matched either via <object>: IValueHttpResult<T> is not covariant in T,
          // so the object variant matches neither concrete result type and the route
          // would silently never cache — no error, no header, a permanent MISS.
          //
          // The non-generic filter matches IValueHttpResult and stores the SERIALIZED
          // body, replaying it verbatim on a hit, so it is indifferent to which of the
          // two shapes the handler produced. What keeps the shapes in separate entries is
          // the KEY: CacheKeys.MyOrders' t0/t1 segment, driven by UserCacheKeyBuilders'
          // reading of the query string.
          .WithCache(UserCacheKeyBuilders.MyOrders, CacheKeys.OrdersTtl);
  ```

  ```csharp
          .Produces<OrderWithTrackingDto>(StatusCodes.Status200OK)
          .Produces(StatusCodes.Status401Unauthorized)
          .Produces(StatusCodes.Status404NotFound)
          // Same two-shapes reason as my-orders above (:75-84), and the same non-generic
          // filter handles it. Note the 404 branch (:70-73) needs no special handling:
          // the filter requires IStatusCodeHttpResult { StatusCode: 200 } before it
          // stores anything, and Results.NotFound() is a 404 — so "no such order" is
          // re-evaluated on every request rather than cached, which is what you want,
          // since a 404 is also what a not-yet-visible order returns.
          .WithCache(UserCacheKeyBuilders.OrderById, CacheKeys.OrdersTtl);
  ```

  Add `using Orders.Api.Caching;` and `using Orders.Application.Abstractions;` to
  `OrderEndpoints.cs`.

  > **Note:** `CachedReadFilter` is **non-generic** and there is no type argument at any
  > `.WithCache` call site. That is deliberate and it is what makes one filter able to serve a
  > route with two response shapes: it matches the non-generic `IValueHttpResult` (plus
  > `IStatusCodeHttpResult { StatusCode: 200 }`), stores `JsonSerializer.Serialize(value)`, and
  > replays a hit as `Results.Content(cachedJson, "application/json")` — so the stored value is
  > always a JSON string and every read goes through `cache.GetAsync<string>(key, ct)`,
  > whatever the handler returned. Separating the two shapes is the **key's** job, not the
  > filter's: `CacheKeys.MyOrders`/`CacheKeys.Order` carry the `t0`/`t1` segment, so the
  > tracking and non-tracking bodies land in different entries and can never be served for one
  > another. If you find yourself reaching for a type argument here, the filter is not the one
  > Task 2 built.

- [ ] **Step 9: Register the invalidator abstraction so the endpoints still build.**

  Create `services/orders/src/Orders.Application/Abstractions/ICacheInvalidator.cs`:

  ```csharp
  namespace Orders.Application.Abstractions;

  /// <summary>
  /// The write path's view of the cache: what to forget, named by the business event that
  /// makes it stale rather than by key.
  /// </summary>
  /// <remarks>
  /// <para>
  /// Deliberately NOT <c>ICacheGateway</c> with a key list at each call site. The write
  /// services live in Infrastructure and would then each have to know which key families a
  /// given write invalidates — and the day a fourth key is added under my-orders, three call
  /// sites need editing and one of them is missed. Naming the EVENT keeps that knowledge in
  /// one implementation.
  /// </para>
  /// <para>
  /// Implementations MUST NOT throw. The cache may never break a write, exactly as it may
  /// never break a read (spec: Failure mode — fail open).
  /// </para>
  /// </remarks>
  public interface ICacheInvalidator
  {
      /// <summary>Forgets the caller's cart entry. For PUT and DELETE /v1/cart.</summary>
      Task InvalidateCartAsync(string cognitoSub, CancellationToken ct);

      /// <summary>
      /// Forgets everything a completed order makes stale: the caller's cart (consumed by the
      /// order), all their my-orders entries (t0 and t1 both), and the shared product catalog
      /// (stock changed).
      /// </summary>
      Task InvalidateOrderCreationAsync(string cognitoSub, CancellationToken ct);

      /// <summary>Forgets the shared product catalog entry. For the E2E restock.</summary>
      Task InvalidateProductsAsync(CancellationToken ct);
  }
  ```

  Create `services/orders/src/Orders.Infrastructure/Caching/CacheInvalidator.cs`:

  ```csharp
  using Microsoft.Extensions.Logging;
  using Orders.Application.Abstractions;

  namespace Orders.Infrastructure.Caching;

  public sealed class CacheInvalidator : ICacheInvalidator
  {
      private readonly ICacheGateway _cache;
      private readonly ILogger<CacheInvalidator> _logger;

      public CacheInvalidator(ICacheGateway cache, ILogger<CacheInvalidator> logger)
      {
          _cache = cache;
          _logger = logger;
      }

      public Task InvalidateCartAsync(string cognitoSub, CancellationToken ct) =>
          // The cart key carries user_id, which this layer does not have and must not make
          // a gRPC call to obtain — the write already committed and a resolution failure
          // here would leave the entry stale for its full TTL for no gain. The per-user key
          // INDEX (a Redis SET of that user's live keys, keyed by sub alone) exists for
          // precisely this: it turns "forget this user's cart" into a lookup that needs
          // only the sub.
          Guarded("cart", () => _cache.InvalidateUserKeysAsync(cognitoSub, ct));

      public Task InvalidateOrderCreationAsync(string cognitoSub, CancellationToken ct) =>
          // One sweep of the user index removes BOTH the cart entry and every my-orders
          // entry (t0 and t1) in a single operation — the t0/t1 suffix is exactly why an
          // index is required here instead of naming keys, and why KEYS/SCAN is not an
          // option (spec: Invalidation matrix, second correctness detail).
          //
          // The catalog key is separate because it belongs to no user: stock changed for
          // everyone, so it cannot live in one user's index.
          Guarded("order_creation", async () =>
          {
              await _cache.InvalidateUserKeysAsync(cognitoSub, ct);
              await _cache.InvalidateAsync(new[] { CacheKeys.Products() }, ct);
          });

      public Task InvalidateProductsAsync(CancellationToken ct) =>
          Guarded("products", () => _cache.InvalidateAsync(new[] { CacheKeys.Products() }, ct));

      /// <summary>
      /// Runs an invalidation and swallows any failure, logging it.
      /// </summary>
      /// <remarks>
      /// Every call site is AFTER the commit, so throwing here could only turn a persisted
      /// write into an error response — the write happened; the caller must be told so. The
      /// consequence of a swallowed failure is bounded by the entry's own TTL (60s for the
      /// cart, 2min for orders, 10min for the catalog), which is what those TTLs are the
      /// safety net for.
      /// </remarks>
      private async Task Guarded(string scope, Func<Task> operation)
      {
          try
          {
              await operation();
          }
          catch (Exception ex)
          {
              _logger.LogWarning(
                  ex,
                  "Cache invalidation failed; entries will expire by TTL {app_event} {reason} {cache_scope}",
                  "cache_unavailable", "invalidate_failed", scope);
          }
      }
  }
  ```

  In `services/orders/src/Orders.Api/Program.cs`, register it beside the other cache services
  Task 2 added:

  ```csharp
  builder.Services.AddScoped<ICacheInvalidator, CacheInvalidator>();
  ```

- [ ] **Step 10: Build and confirm the endpoints compile with the filter attached.**

  Run: `cd services/orders && dotnet build`

  Expected: `Build succeeded` with 0 errors. This build also regenerates
  `services/orders/openapi.yaml` (the `ConvertOpenApiToYaml` MSBuild target — see
  `services/orders/CLAUDE.md` §2a). `.WithCache` adds no `.Produces` metadata, so the diff on
  `openapi.yaml` should be empty; confirm with `git diff --stat services/orders/openapi.yaml`
  and expect **no output**. If the file did change, commit it with the code per §2a.

- [ ] **Step 11: Wire cart invalidation into `CartWriteService`, then run the cart cache test.**

  In `services/orders/src/Orders.Infrastructure/Carts/CartWriteService.cs`:

  Add the constructor parameter and field (constructor currently at `:26-38`):

  ```csharp
  private readonly ICacheInvalidator _cache;

  public CartWriteService(
      OrdersWriteDbContext db,
      IUserDirectory users,
      CartReadService reads,
      IWorkflowTracer tracer,
      ICacheInvalidator cache,
      ILogger<CartWriteService> logger)
  {
      _db = db;
      _users = users;
      _reads = reads;
      _tracer = tracer;
      _cache = cache;
      _logger = logger;
  }
  ```

  Change `ReplaceAsync` (`:50-57`) from an expression body to a block that invalidates **after**
  `ReplaceInternalAsync` returns:

  ```csharp
  public Task<CartDto> ReplaceAsync(
      UpdateCartCommand command,
      string cognitoSub,
      CancellationToken ct = default) =>
      _tracer.TraceWorkflowAsync(
          "update_cart",
          new Dictionary<string, object?> { ["app_event"] = "update_cart_started" },
          async () =>
          {
              var cart = await ReplaceInternalAsync(command, cognitoSub, ct);

              // AFTER the write has persisted, never before — invalidating first lets a
              // concurrent read repopulate the stale value in the window between the delete
              // and the commit landing (spec: Invalidation).
              //
              // THIS is the seam, and it is the only one that works. ReplaceInternalAsync
              // commits in THREE places: the emptied branch (:114-115), the unique-index
              // race retry (:172-173), and the normal path (:181). Putting the call after
              // any one of them covers one third of the writes; putting it here, after the
              // method returns, covers all three by construction — including a fourth
              // commit site somebody adds later.
              await _cache.InvalidateCartAsync(cognitoSub, ct);

              return cart;
          });
  ```

  In `DeleteAsync` (`:204-239`), add the invalidation after the `AmbientActor.RunAsync` block
  (which is where `SaveChangesAsync` at `:224` completes) and before the `delete_cart_succeeded`
  log line:

  ```csharp
              await AmbientActor.RunAsync(AuditActor.DeleteCart, async () =>
              {
                  await DeleteForUserAsync(_db, cognitoSub, ct);
                  await _db.SaveChangesAsync(ct);
                  return true;
              });

              // After the save, for the same reason ReplaceAsync invalidates after its
              // commit. There is no explicit transaction on this path — SaveChangesAsync
              // above IS the commit — so this line is the first moment the deletion is
              // durable.
              await _cache.InvalidateCartAsync(cognitoSub, ct);
  ```

  `CartWriteService` is registered as `builder.Services.AddScoped<CartWriteService>()`
  (`Program.cs:192`), which resolves constructor parameters from the container automatically —
  so **no factory lambda needs editing for this class**.

  > **Note:** the brief stated `CartWriteService` is registered via an explicit factory lambda.
  > It is not — `Program.cs:192` is a plain `AddScoped<CartWriteService>()`; only
  > `ProductReadService` (`:181`), `CartReadService` (`:186`) and `CreateOrderService`
  > (`:360-367`) use factory lambdas. Adding the parameter here is therefore a one-file change.
  > `CreateOrderService` in Step 14 **does** need its lambda updated, as stated.

  Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CartCacheTests`

  Expected: `Passed! - Failed: 0, Passed: 2`.

- [ ] **Step 12: Commit the cart caching and invalidation.**

  Run:
  ```
  cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga
  git add services/orders/src/Orders.Api/Endpoints/CartEndpoints.cs \
          services/orders/src/Orders.Api/Endpoints/OrderEndpoints.cs \
          services/orders/src/Orders.Api/Program.cs \
          services/orders/src/Orders.Application/Abstractions/ICacheInvalidator.cs \
          services/orders/src/Orders.Infrastructure/Caching/CacheInvalidator.cs \
          services/orders/src/Orders.Infrastructure/Carts/CartWriteService.cs \
          services/orders/tests/Orders.Tests/Api/CartCacheTests.cs
  git commit -m "feat(orders): cache GET /v1/cart and invalidate it on every cart write"
  ```

  Expected: one commit, 7 files changed.

- [ ] **Step 13: Write the failing my-orders test — separate caching per `includeTracking`, and order creation invalidates everything.**

  Create `services/orders/tests/Orders.Tests/Api/OrderCacheTests.cs`:

  ```csharp
  using System.Net;
  using System.Net.Http.Json;
  using System.Text.Json;
  using Xunit;

  namespace Orders.Tests.Api;

  [Collection(OrdersApiCollection.Name)]
  public class OrderCacheTests
  {
      private readonly OrdersApiFactory _factory;

      public OrderCacheTests(OrdersApiFactory factory) => _factory = factory;

      private HttpClient Client(string sub)
      {
          var client = _factory.CreateClient();
          client.DefaultRequestHeaders.Add("x-user-id", sub);
          return client;
      }

      private static string? CacheHeader(HttpResponseMessage response) =>
          response.Headers.TryGetValues("X-Cache", out var values)
              ? values.FirstOrDefault()
              : null;

      // The two includeTracking variants return DIFFERENT SHAPES from one route
      // (OrderEndpoints.cs:36-49): a bare OrderDto list at t0, an OrderWithTrackingDto[]
      // at t1. If they shared a key, whichever ran first would serve its shape to the
      // other — a caller asking for tracking would get a list with no `tracking` key, or
      // a caller asking for the bare list would get objects wrapped under `order`. This
      // is the subtlest way this task can go wrong, so it is asserted on the BODY SHAPE
      // and not merely on the X-Cache header.
      [Fact]
      public async Task Include_tracking_variants_are_cached_under_separate_keys()
      {
          await _factory.FlushCacheAsync();
          var client = Client(OrdersApiFactory.KnownCognitoSub);

          var bareFirst = await client.GetAsync("/v1/orders/my-orders");
          Assert.Equal(HttpStatusCode.OK, bareFirst.StatusCode);
          Assert.Equal("MISS", CacheHeader(bareFirst));

          // A SECOND read at the same variant hits...
          Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));

          // ...but the OTHER variant is a fresh key, so it must MISS, not inherit the hit.
          var wrappedFirst = await client.GetAsync("/v1/orders/my-orders?includeTracking=true");
          Assert.Equal("MISS", CacheHeader(wrappedFirst));
          Assert.Equal(
              "HIT",
              CacheHeader(await client.GetAsync("/v1/orders/my-orders?includeTracking=true")));

          // And the cached bodies keep their own shapes. Both are arrays; the wrapped one's
          // elements carry an `order` object, the bare one's carry `id` directly.
          var bare = await (await client.GetAsync("/v1/orders/my-orders"))
              .Content.ReadFromJsonAsync<JsonElement>();
          var wrapped = await (await client.GetAsync("/v1/orders/my-orders?includeTracking=true"))
              .Content.ReadFromJsonAsync<JsonElement>();

          foreach (var element in bare.EnumerateArray())
          {
              Assert.True(element.TryGetProperty("id", out _));
              Assert.False(element.TryGetProperty("order", out _));
          }

          foreach (var element in wrapped.EnumerateArray())
          {
              Assert.True(element.TryGetProperty("order", out _));
          }
      }

      // One create-order commit makes THREE things stale at once: the cart it consumed,
      // every my-orders entry (the new order belongs in the list), and the shared product
      // catalog (stock decremented). Missing any one of the three is a silent staleness
      // bug, so all three are asserted in a single test rather than three that could each
      // pass while the composite behaviour is wrong.
      [Fact]
      public async Task Creating_an_order_invalidates_cart_my_orders_and_products()
      {
          await _factory.FlushCacheAsync();
          var client = Client(OrdersApiFactory.KnownCognitoSub);

          await client.PutAsJsonAsync("/v1/cart", new
          {
              items = new[] { new { productId = _factory.SeededProductId, quantity = 1 } },
          });

          // Warm all three to HIT.
          await client.GetAsync("/v1/cart");
          Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/cart")));
          await client.GetAsync("/v1/orders/my-orders");
          Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
          await client.GetAsync("/v1/products");
          Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/products")));

          var created = await client.PostAsJsonAsync("/v1/orders", new
          {
              lines = new[] { new { productId = _factory.SeededProductId, quantity = 1 } },
          });
          Assert.Equal(HttpStatusCode.Created, created.StatusCode);

          Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/cart")));
          Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/orders/my-orders")));
          Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/products")));

          // Not just a MISS — the refreshed my-orders body must actually contain the new
          // order. A MISS proves the entry was removed; this proves the removal happened
          // AFTER the commit and not before it (invalidating first would let this very
          // read repopulate the pre-order list).
          var orders = await (await client.GetAsync("/v1/orders/my-orders"))
              .Content.ReadFromJsonAsync<JsonElement>();
          Assert.Contains(
              orders.EnumerateArray(),
              o => o.GetProperty("id").GetString() ==
                   (await created.Content.ReadFromJsonAsync<JsonElement>())
                       .GetProperty("id").GetString());
      }

      [Fact]
      public async Task Order_by_id_is_cached_and_a_404_is_not()
      {
          await _factory.FlushCacheAsync();
          var client = Client(OrdersApiFactory.KnownCognitoSub);

          var created = await client.PostAsJsonAsync("/v1/orders", new
          {
              lines = new[] { new { productId = _factory.SeededProductId, quantity = 1 } },
          });
          Assert.Equal(HttpStatusCode.Created, created.StatusCode);
          var orderId = (await created.Content.ReadFromJsonAsync<JsonElement>())
              .GetProperty("id").GetString();

          Assert.Equal("MISS", CacheHeader(await client.GetAsync($"/v1/orders/{orderId}")));
          Assert.Equal("HIT", CacheHeader(await client.GetAsync($"/v1/orders/{orderId}")));

          // A 404 is never stored: only 200s are cached (spec: CachedRead interceptor).
          // Two consecutive misses on a non-existent id is the observable proof.
          var missing = $"ord_{Guid.NewGuid():N}"[..20];
          Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/v1/orders/{missing}")).StatusCode);
          Assert.Equal("MISS", CacheHeader(await client.GetAsync($"/v1/orders/{missing}")));
          Assert.Equal("MISS", CacheHeader(await client.GetAsync($"/v1/orders/{missing}")));
      }
  }
  ```

- [ ] **Step 14: Run the order cache test and confirm the invalidation facts fail.**

  Run: `cd services/orders && dotnet test --filter FullyQualifiedName~OrderCacheTests`

  Expected:
  - `Include_tracking_variants_are_cached_under_separate_keys` — **passes** already (Step 8
    attached the filter and Step 3's builder already varies the key on `t0`/`t1`). Two distinct
    failures are possible here and they point at different files:
    - `Expected: "MISS", Actual: "HIT"` on the `includeTracking=true` read — the two variants
      are sharing a key, so the builder is not reading the query string; go back to Step 3's
      `IncludeTracking`.
    - `Expected: "HIT", Actual: "MISS"` on either second read — nothing is being stored at
      all. The filter is not recognizing the handler's result. Check that `CachedReadFilter`
      matches the **non-generic** `IValueHttpResult`; a filter that tests for
      `IValueHttpResult<T>` matches neither `Ok<IReadOnlyList<OrderDto>>` nor
      `Ok<OrderWithTrackingDto[]>` and produces exactly this permanent-MISS symptom with no
      error anywhere.
  - `Creating_an_order_invalidates_cart_my_orders_and_products` — **fails** with
    `Assert.Equal() Failure — Expected: "MISS", Actual: "HIT"` on the first post-create cart
    read. `CreateOrderService` does not invalidate yet.
  - `Order_by_id_is_cached_and_a_404_is_not` — **passes** already (read-side only).

- [ ] **Step 15: Wire invalidation into `CreateOrderService` after the commit.**

  In `services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs`:

  Add the constructor parameter and field (constructor at `:37-53`):

  ```csharp
  private readonly ICacheInvalidator _cache;

  public CreateOrderService(
      OrdersWriteDbContext db,
      IUserDirectory users,
      IEventPublisher events,
      IConfigurationReader config,
      ITrackingInitiator tracking,
      IWorkflowTracer tracer,
      ICacheInvalidator cache,
      ILogger<CreateOrderService> logger)
  {
      _db = db;
      _users = users;
      _events = events;
      _config = config;
      _tracking = tracking;
      _tracer = tracer;
      _cache = cache;
      _logger = logger;
  }
  ```

  In `CreateInternalAsync`, insert the invalidation immediately after `await tx.CommitAsync(ct);`
  (`:286`) and before the `create_order_succeeded` log line:

  ```csharp
          await tx.CommitAsync(ct);

          // AFTER the commit, alongside the success log and the tracking init that already
          // live here for the same reason: at this point the order genuinely exists.
          //
          // One commit, three stale things. The cart was deleted INSIDE the transaction
          // above (:254, via CartWriteService.DeleteForUserAsync), so its cached entry is
          // wrong the moment this commit lands; my-orders is missing the order that was
          // just created; and orders:products:v1 is holding stock counts this order just
          // decremented. InvalidateOrderCreationAsync removes all three — the cart and
          // every my-orders variant through the caller's key index, the catalog by name.
          //
          // Invalidating BEFORE the commit would be wrong in a way tests do not usually
          // catch: a concurrent read landing in the window between the delete and the
          // commit would repopulate the entry with the pre-order state and it would then
          // sit there, stale, for its full TTL.
          //
          // ICacheInvalidator swallows its own failures, so this cannot fail an order that
          // was already paid for — the same rule the tracking init below follows.
          await _cache.InvalidateOrderCreationAsync(cognitoSub, ct);

          _logger.LogInformation(
              "Order creation completed {app_event} {order_id} {line_count} {total_cents}",
              "create_order_succeeded", order.Id, order.Details.Count, total);
  ```

  `CreateOrderService` **is** registered via an explicit factory lambda (`Program.cs:360-367`),
  which lists every constructor argument by hand — a new parameter is a compile error there
  until the lambda is updated. Change it to:

  ```csharp
  builder.Services.AddScoped(sp => new CreateOrderService(
      sp.GetRequiredService<OrdersWriteDbContext>(),
      sp.GetRequiredService<IUserDirectory>(),
      sp.GetRequiredService<IEventPublisher>(),
      sp.GetRequiredService<IConfigurationReader>(),
      sp.GetRequiredService<ITrackingInitiator>(),
      sp.GetRequiredService<IWorkflowTracer>(),
      sp.GetRequiredService<ICacheInvalidator>(),
      sp.GetRequiredService<ILogger<CreateOrderService>>()));
  ```

- [ ] **Step 16: Run the order cache test and confirm all three facts pass.**

  Run: `cd services/orders && dotnet test --filter FullyQualifiedName~OrderCacheTests`

  Expected: `Passed! - Failed: 0, Passed: 3`.

- [ ] **Step 17: Commit the order caching and create-order invalidation.**

  Run:
  ```
  cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga
  git add services/orders/src/Orders.Api/Program.cs \
          services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs \
          services/orders/tests/Orders.Tests/Api/OrderCacheTests.cs
  git commit -m "feat(orders): cache my-orders and order-by-id, invalidate on order creation"
  ```

  Expected: one commit, 3 files changed.

- [ ] **Step 18: Write the failing cross-user isolation test.**

  This is the non-negotiable one. Every other test in this task could pass while the cache
  still serves user A's cart to user B — the only way that surfaces is by asking two different
  callers for the same route and comparing the bodies.

  It uses `OrdersE2eApiFactory`, whose stub directory resolves a **second** sub
  (`OtherCognitoSub = "sub-other"` → `OtherUserId = "usr_other"`,
  `OrdersE2eApiFactory.cs:47-48`, `:165`). `OrdersApiFactory`'s stub resolves only
  `KnownCognitoSub`, so a second caller there would land in the null-identity path and be
  skipped by the key builder — the test would pass for entirely the wrong reason.

  Create `services/orders/tests/Orders.Tests/Api/CacheCrossUserTests.cs`:

  ```csharp
  using System.Net;
  using System.Net.Http.Json;
  using System.Text.Json;
  using Xunit;

  namespace Orders.Tests.Api;

  [Collection(OrdersE2eApiCollection.Name)]
  public class CacheCrossUserTests
  {
      private readonly OrdersE2eApiFactory _factory;

      public CacheCrossUserTests(OrdersE2eApiFactory factory) => _factory = factory;

      private HttpClient Client(string sub)
      {
          var client = _factory.CreateClient();
          client.DefaultRequestHeaders.Add("x-user-id", sub);
          return client;
      }

      private static string? CacheHeader(HttpResponseMessage response) =>
          response.Headers.TryGetValues("X-Cache", out var values)
              ? values.FirstOrDefault()
              : null;

      [Fact]
      public async Task User_b_never_receives_user_a_cached_cart()
      {
          await _factory.FlushCacheAsync();

          var a = Client(OrdersE2eApiFactory.KnownCognitoSub);
          var b = Client(OrdersE2eApiFactory.OtherCognitoSub);

          // A has a cart with one line.
          var putA = await a.PutAsJsonAsync("/v1/cart", new
          {
              items = new[] { new { productId = _factory.SeededProductId, quantity = 3 } },
          });
          Assert.Equal(HttpStatusCode.OK, putA.StatusCode);

          // Warm A's entry to a confirmed HIT, so the cache definitely holds A's cart.
          Assert.Equal("MISS", CacheHeader(await a.GetAsync("/v1/cart")));
          Assert.Equal("HIT", CacheHeader(await a.GetAsync("/v1/cart")));

          // B, who has no cart at all, must MISS — a HIT here would already mean B read
          // A's entry.
          var firstB = await b.GetAsync("/v1/cart");
          Assert.Equal("MISS", CacheHeader(firstB));

          // And the BODY is B's own empty cart, not A's three units. The header alone is
          // not enough: a filter that keyed correctly but served the wrong stored value
          // would still report MISS on this first read.
          var bodyB = await firstB.Content.ReadFromJsonAsync<JsonElement>();
          Assert.Empty(bodyB.GetProperty("items").EnumerateArray());

          // B's own second read hits B's own entry, still empty.
          var secondB = await b.GetAsync("/v1/cart");
          Assert.Equal("HIT", CacheHeader(secondB));
          var secondBodyB = await secondB.Content.ReadFromJsonAsync<JsonElement>();
          Assert.Empty(secondBodyB.GetProperty("items").EnumerateArray());

          // A is untouched by any of B's traffic.
          var bodyA = await (await a.GetAsync("/v1/cart")).Content.ReadFromJsonAsync<JsonElement>();
          Assert.Equal(3, bodyA.GetProperty("items").EnumerateArray().First()
              .GetProperty("quantity").GetInt32());
      }

      [Fact]
      public async Task Invalidating_user_a_does_not_invalidate_user_b()
      {
          await _factory.FlushCacheAsync();

          var a = Client(OrdersE2eApiFactory.KnownCognitoSub);
          var b = Client(OrdersE2eApiFactory.OtherCognitoSub);

          await a.GetAsync("/v1/cart");
          await b.GetAsync("/v1/cart");
          Assert.Equal("HIT", CacheHeader(await a.GetAsync("/v1/cart")));
          Assert.Equal("HIT", CacheHeader(await b.GetAsync("/v1/cart")));

          // A writes. The per-user key index must scope the sweep to A alone — an
          // implementation that flushed the database, or matched keys by a prefix broad
          // enough to catch both, would pass every other test in this task and only fail
          // here.
          await a.PutAsJsonAsync("/v1/cart", new
          {
              items = new[] { new { productId = _factory.SeededProductId, quantity = 1 } },
          });

          Assert.Equal("MISS", CacheHeader(await a.GetAsync("/v1/cart")));
          Assert.Equal("HIT", CacheHeader(await b.GetAsync("/v1/cart")));
      }
  }
  ```

- [ ] **Step 19: Run the cross-user test and confirm the result.**

  Run: `cd services/orders && dotnet test --filter FullyQualifiedName~CacheCrossUserTests`

  Expected: `Passed! - Failed: 0, Passed: 2`. Unlike the earlier cycles this one should be
  green on the first run — `CacheKeys.Cart(sub, userId)` already embeds both identifiers, and
  `InvalidateUserKeysAsync(cognitoSub, …)` is already per-user. That is the point: it is a
  **characterization** test proving the isolation property holds, and it is written so that any
  later change breaking it fails loudly here.

  If `Invalidating_user_a_does_not_invalidate_user_b` fails with
  `Expected: "HIT", Actual: "MISS"` on B's read, the invalidation is over-broad — check that
  `CacheGateway.InvalidateUserKeysAsync` reads `CacheKeys.UserIndex(sub)` and does not fall
  back to a `SCAN`/pattern delete.

- [ ] **Step 20: Commit the cross-user isolation test.**

  Run:
  ```
  cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga
  git add services/orders/tests/Orders.Tests/Api/CacheCrossUserTests.cs
  git commit -m "test(orders): cross-user isolation for the response cache"
  ```

  Expected: one commit, 1 file changed.

- [ ] **Step 21: Write the failing test for the E2E cleanup invalidation.**

  `DELETE /v1/orders/e2e-cleanup` restocks the catalogue via three `ExecuteUpdateAsync` calls
  (`E2eEndpoints.cs:40`, `:48`, `:72`), which issue raw SQL `UPDATE`s and **bypass
  `SaveChanges` entirely** — so nothing in the ordinary write path fires for it and
  `orders:products:v1` keeps serving the drained stock figures for its full 10-minute TTL. An
  E2E run's second suite then reads a catalogue that says zero.

  Append to `services/orders/tests/Orders.Tests/Api/CacheCrossUserTests.cs`
  (`OrdersE2eApiFactory` is the host that maps this route — it sets `E2E_TESTING_ENABLED=true`,
  `OrdersE2eApiFactory.cs:108`):

  ```csharp
      // The cleanup restocks the catalogue with ExecuteUpdateAsync (E2eEndpoints.cs:72),
      // which bypasses SaveChanges — so no interceptor, no write service, and nothing that
      // would otherwise invalidate. Without an explicit call the cached catalogue keeps
      // reporting the drained stock for the whole 10-minute TTL, and the next E2E run reads
      // a zero-stock catalogue and fails on fixtures that merely need to place an order.
      [Fact]
      public async Task E2e_cleanup_invalidates_the_product_catalogue()
      {
          await _factory.FlushCacheAsync();

          var client = Client(OrdersE2eApiFactory.KnownCognitoSub);

          Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/products")));
          Assert.Equal("HIT", CacheHeader(await client.GetAsync("/v1/products")));

          var cleanup = await client.DeleteAsync("/v1/orders/e2e-cleanup");
          Assert.Equal(HttpStatusCode.OK, cleanup.StatusCode);

          Assert.Equal("MISS", CacheHeader(await client.GetAsync("/v1/products")));
      }
  ```

  Run: `cd services/orders && dotnet test --filter FullyQualifiedName~E2e_cleanup_invalidates`

  Expected: fails with `Assert.Equal() Failure — Expected: "MISS", Actual: "HIT"` on the last
  assertion.

- [ ] **Step 22: Invalidate the catalogue from the E2E cleanup endpoint.**

  In `services/orders/src/Orders.Api/Endpoints/E2eEndpoints.cs`, add the invalidator to the
  handler's parameter list (line 20) and call it after the restock loop, before the response:

  ```csharp
  app.MapDelete("/v1/orders/e2e-cleanup", async (
      OrdersWriteDbContext db,
      ICacheInvalidator cache) =>
  {
  ```

  ...and immediately before `return Results.Ok(new E2eCleanupResponse(...));` (currently line
  84):

  ```csharp
      // The three ExecuteUpdateAsync calls above bypass SaveChanges and therefore every
      // interceptor and write service in this codebase — nothing else in the request would
      // ever tell the cache the catalogue moved. Without this line the restocked stock is
      // invisible for the catalogue entry's full 10-minute TTL, which is longer than an E2E
      // suite runs: the next run reads zeros and fails on fixtures that only need to place
      // an order.
      //
      // Only the catalogue. Per-user entries are keyed by sub and this endpoint deletes BY
      // TAG across every user an E2E run touched (see the comment at :24-34) — it has no
      // caller identity at all to sweep by, and the orders it soft-deletes are E2E rows that
      // no real session is reading.
      await cache.InvalidateProductsAsync(CancellationToken.None);

      return Results.Ok(new E2eCleanupResponse(deleted, deletedDetails, restocked));
  ```

  Add `using Orders.Application.Abstractions;` to the file — it is already imported (line 2),
  so no change is needed there if `ICacheInvalidator` lives in that namespace.

  Run: `cd services/orders && dotnet test --filter FullyQualifiedName~E2e_cleanup_invalidates`

  Expected: `Passed! - Failed: 0, Passed: 1`.

- [ ] **Step 23: Run the full Orders test suite.**

  Run: `cd services/orders && dotnet test`

  Expected: `Passed!` with 0 failures across every test class. Watch specifically for
  regressions in `CartEndpointsTests`, `CartCheckoutTests` and `CreateOrderEndpointTests` —
  those exercise the same write paths that now carry an invalidation call, and a
  `NullReferenceException` on `_cache` there means a construction site was missed. Note the
  suite runs serially (`AssemblyInfo.cs:23` disables parallelization), so the shared Redis
  cannot be raced by a concurrent class; but each cache test still flushes, because the classes
  run in an unspecified ORDER.

- [ ] **Step 24: Regenerate and verify `openapi.yaml`.**

  Run:
  ```
  cd services/orders && dotnet build && \
  git -C /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga \
      diff --stat services/orders/openapi.yaml
  ```

  Expected: `Build succeeded`, and **no diff output**. This task changed no `.Produces`,
  `.Accepts`, `.WithName`, `.WithSummary`, route path, or DTO — `.WithCache` contributes no
  OpenAPI metadata, and `X-Cache` is a response *header* which this generator does not emit.
  A non-empty diff means something else changed inadvertently: read it, and if it is legitimate
  commit the file with the code, per the GOLDEN RULE in `services/orders/CLAUDE.md` §2a.

- [ ] **Step 25: Verify no full cache key reaches a span or a metric.**

  Run:
  ```
  cd services/orders && \
  grep -rn "cache.key\|CacheKeys\.\(Cart\|MyOrders\|Order\)(" src/ --include=*.cs | \
    grep -iv "test" | grep -i "SetAttribute\|SetTag\|Dimension\|PublishAsync"
  ```

  Expected: **no output**. Per the spec's Observability section a full key carries
  `cognito_sub` and `user_id`, and a span is an export destination like any other — only
  `cache.key_prefix` (e.g. `orders:cart:v1`) may be attached. If this prints a line, that call
  site is putting a whole key on a span or a CloudWatch dimension; replace it with the prefix.

- [ ] **Step 26: Commit the E2E cleanup invalidation and close the task.**

  Run:
  ```
  cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga
  git add services/orders/src/Orders.Api/Endpoints/E2eEndpoints.cs \
          services/orders/tests/Orders.Tests/Api/CacheCrossUserTests.cs
  git commit -m "fix(orders): invalidate the cached catalogue on e2e-cleanup restock"
  ```

  Expected: one commit, 2 files changed.

  What Task 3 does **not** cover, so it is not mistaken for missing: the internal-E2E and
  gateway-E2E layers for these three routes (`e2e/tests/`), and the load-test scenarios — both
  belong to `e2e-impl` and are separate tasks in this plan, per [[testing]]'s three-layer rule.
  The routes themselves already exist at the gateway and in
  `infra/modules/compute/nginx/nginx.conf`, so no route wiring is required here; this task adds
  a response *header* to routes that already resolve end to end.

---
### Task 4: Tracking — cached reads, the identity cache, and carrier-webhook invalidation

Tracking is a FastAPI service written in Python 3.12. It exposes two user-scoped read
endpoints (`GET /v1/trackings/{order_id}` and `GET /v1/trackings?order_ids=a,b,c`) and one
write endpoint driven by an external shipping carrier (`PUT /v1/trackings/{order_id}/status`).
This task puts a Redis response cache in front of the two reads, caches the
`cognito_sub -> user_id` identity resolution that the cache keys need, and invalidates the
read cache from the carrier webhook after its transaction commits.

Everything here mirrors the **semantics** already established for Orders in Tasks 2–3 — same
key shapes, same TTLs, same `X-Cache` header contract, same fail-open rule — but none of the
code. Orders is .NET; this is FastAPI.

**Four hard constraints that shape every step below:**

1. **Fail open.** Every Redis operation has a 50 ms timeout. Any timeout or error means the
   request falls through to MySQL and answers `X-Cache: BYPASS`. The cache may never break or
   degrade a read.
2. **Only `200` responses are cached.** A `404`, a `400`, a `401` is never written.
3. **Headers.** `X-Cache: HIT` carries `X-Cache-TTL: <seconds remaining>`. `X-Cache: MISS` and
   `X-Cache: BYPASS` carry no TTL header. With `CACHE_ENABLED=false` **no header at all** is
   emitted.
4. **Prefix only in telemetry.** A span attribute or a CloudWatch dimension carries
   `tracking:order:v1`, never the full key — the full key embeds `cognito_sub` and `user_id`.

**Files:**

- Create: `services/tracking/src/shared/cache/__init__.py`
- Create: `services/tracking/src/shared/cache/keys.py`
- Create: `services/tracking/src/shared/cache/gateway.py`
- Create: `services/tracking/src/shared/cache/redis_client.py`
- Create: `services/tracking/src/shared/cache/identity_cache.py`
- Create: `services/tracking/src/shared/cache/invalidation.py`
- Create: `services/tracking/src/shared/http/cache_dependencies.py`
- Modify: `services/tracking/src/shared/config/settings.py` (add `cache_enabled`,
  `redis_host`, `redis_port`, `cache_timeout_ms`)
- Modify: `services/tracking/src/shared/logging/log_context.py` (add `cache_result` to
  `_ALLOWED_KEYS`)
- Modify: `services/tracking/src/shared/http/log_identity.py` (route the gRPC resolution
  through the identity cache)
- Modify: `services/tracking/src/features/tracking/api/trackings_router.py` (both reads
  become cached)
- Modify: `services/tracking/src/features/tracking/api/carrier_router.py` (invalidate after
  the commit)
- Modify: `services/tracking/requirements.txt` (add `fakeredis==2.26.2` to the dev/test block)
- Modify: `services/tracking/requirements-runtime.txt` (add `redis==5.2.1`)
- Modify: `services/tracking/tests/conftest.py` (a `redis_client` fixture + a
  `get_cache_gateway` override in the `app` fixture)
- Modify: `services/tracking/tests/test_settings.py` (`MANAGED_KEYS`)
- Modify: `services/tracking/openapi.yaml` (regenerated, not hand-edited)
- Test: `services/tracking/tests/test_cache_keys.py` (new)
- Test: `services/tracking/tests/test_cache_gateway.py` (new)
- Test: `services/tracking/tests/test_cached_reads.py` (new)
- Test: `services/tracking/tests/test_cache_invalidation.py` (new)
- Test: `services/tracking/tests/test_identity_cache.py` (new)

> **Note:** the brief states "Task 1 added `cache_enabled: bool = True`" to
> `services/tracking/src/shared/config/settings.py` and "Task 1 added `redis==5.2.1` to
> `requirements-runtime.txt`". Neither is true in this worktree: `git log --oneline -1` is
> `591c393 docs(vault): design the response caching layer and the X-Cache header contract`,
> a docs-only commit, and `grep -rn "cache_enabled\|redis" services/tracking/src
> services/tracking/requirements*.txt` returns nothing. **Trust the code.** Steps 1–4 below
> therefore add both. If Task 1 has landed by the time you run this, those two steps are
> no-ops — verify with the same grep before editing rather than duplicating the field.

**Interfaces:**

Consumes (all verified to exist today):

- `CurrentCaller.cognito_sub -> str` — `src/shared/http/caller.py:95`. A property; **no
  network call, ever.**
- `CurrentCaller.resolved_internal_user_id -> str | None` — `caller.py:100`. Also no network;
  returns `None` when resolution has not happened or came back unknown.
- `CurrentCaller.resolve_internal_user_id() -> str` — `caller.py:110`. THE gRPC call, memoized
  per request, raises `UnknownUserError` when Users has no record.
- `UsersGrpcClient.resolve(identifier: str) -> ResolvedUser | None` —
  `src/shared/grpc/users_client.py:225`. `ResolvedUser` is
  `@dataclass(frozen=True, slots=True)` at `:88` with `internal_id`, `cognito_sub`, `email`,
  `full_name`.
- `stamp_caller_user_id(cognito_sub: CallerSub, users: OptionalUsersClient) -> CurrentCaller`
  — `src/shared/http/log_identity.py:129`, `async def`.
  `IdentifiedCaller = Annotated[CurrentCaller, Depends(stamp_caller_user_id)]` at `:219`.
- `update_tracking_status(session, command, *, actor=AuditActor.CARRIER_STATUS_UPDATE,
  publisher=None) -> Tracking` — `src/features/tracking/commands/update_status.py:74`.
  Returns the persisted entity; `Tracking.cognito_sub: str | None` at
  `src/features/tracking/domain/models.py:102` (**nullable**).
- `get_write_session() -> Iterator[Session]` — `src/shared/http/dependencies.py:34`, wrapping
  `write_session()` at `src/shared/db/engine.py:107`, which does `yield session;
  session.commit()`. **The commit happens in the dependency's teardown, after the handler
  returns.**
- `workflow_span(name: str, **attributes) -> Iterator[Span]` —
  `src/shared/observability/workflow_tracing.py:89`, re-exported from
  `src/shared/observability/__init__.py`.
- `MetricsPublisher` Protocol (`publish(name: str, value: float, dimensions: dict[str,str]) ->
  None`, documented NEVER to raise) / `CloudWatchMetricsPublisher` / `NoopMetricsPublisher` —
  `src/shared/metrics/cloudwatch_metrics.py:63`, `:73`, `:144`. `SERVICE_DIMENSION =
  "tracking"` at `:62`.
- `merge_log_context(**fields) -> None` — `src/shared/logging/log_context.py:81`, filtered by
  the `_ALLOWED_KEYS` frozenset at `:46`.

Produces:

- `CacheKeys.tracking_order(cognito_sub: str, user_id: str | None, order_id: str) -> str | None`
- `CacheKeys.tracking_list(cognito_sub: str, user_id: str | None, order_ids: list[str]) -> str | None`
- `CacheKeys.identity(cognito_sub: str) -> str`
- `CacheKeys.user_index(cognito_sub: str, user_id: str) -> str`
- `CacheEntry` — `@dataclass(frozen=True, slots=True)` with `hit: bool`, `value: Any | None`,
  `ttl_remaining: int | None`, `bypassed: bool`
- `CacheGateway.get(key: str) -> CacheEntry`
- `CacheGateway.set(key: str, value: Any, ttl_seconds: int, *, index_key: str | None = None) -> None`
- `CacheGateway.invalidate(*keys: str) -> None`
- `CacheGateway.invalidate_index(index_key: str) -> None`
- `IdentityCache.resolve(cognito_sub: str, loader: Callable[[], str | None]) -> str | None`
- `invalidate_tracking(gateway, *, order_id: str, cognito_sub: str | None) -> None`
- `get_cache_gateway() -> CacheGateway` — the FastAPI dependency seam tests override
- `CacheGatewayDep = Annotated[CacheGateway, Depends(get_cache_gateway)]`

---

#### Part A — configuration and dependencies

- [ ] **Step 1: Add the Redis runtime dependency.**
      Append to `services/tracking/requirements-runtime.txt`, after the `boto3==1.40.41` line
      and before the `# --- OpenTelemetry (traces) ---` header:
      ```
      # Redis client for the HTTP response cache and the identity-mapping cache
      # (src/shared/cache/). Runtime, not dev: the running container is what reads and
      # writes the cache. Deliberately NOT paired with an
      # opentelemetry-instrumentation-redis package — that instrumentation lives on the
      # 0.x train, which this file's header explains must move in lockstep with the 1.x
      # SDK; the cache emits its own manual spans instead (shared/cache/gateway.py).
      redis==5.2.1
      ```

- [ ] **Step 2: Add the fake-Redis test dependency.**
      Append to `services/tracking/requirements.txt`, at the end of the `# --- dev / test ---`
      block:
      ```
      # In-process Redis double for the cache suite. Chosen over a real Redis on purpose:
      # the DB suite must hit real MySQL (a mock cannot catch a schema or driver bug — see
      # tests/conftest.py), but a cache has NO schema and NO dialect, so a real server buys
      # nothing and costs a hard dependency on Floci's valkey container being up for a suite
      # that otherwise only needs MySQL. fakeredis implements the exact `redis` client API
      # this code calls (get/setex/delete/sadd/smembers/ttl/pipeline), including TTL
      # semantics, so the code under test is the production code path.
      fakeredis==2.26.2
      ```
      Then install: `cd services/tracking && pip install -r requirements.txt`.
      Expected: `Successfully installed fakeredis-2.26.2 redis-5.2.1 ...`.

- [ ] **Step 3: Write the failing settings test.**
      In `services/tracking/tests/test_settings.py`, add `"CACHE_ENABLED"`, `"REDIS_HOST"`,
      `"REDIS_PORT"` and `"CACHE_TIMEOUT_MS"` to the `MANAGED_KEYS` tuple (at `:26`), leaving
      `MINIMAL_ENV` untouched — all four have defaults, so none is required and none belongs
      in `MINIMAL_ENV`. Then add this class at the end of the file:
      ```python
      class TestCacheSettings:
          """The cache is opt-OUT, and its address defaults to the compose service name."""

          def test_cache_is_enabled_by_default(self) -> None:
              assert build().cache_enabled is True

          def test_cache_can_be_disabled(self) -> None:
              assert build(CACHE_ENABLED="false").cache_enabled is False

          def test_redis_address_defaults_to_the_compose_service(self) -> None:
              settings = build()
              assert settings.redis_host == "redis"
              assert settings.redis_port == 6379

          def test_redis_address_is_overridable(self) -> None:
              settings = build(REDIS_HOST="floci", REDIS_PORT="6380")
              assert settings.redis_host == "floci"
              assert settings.redis_port == 6380

          def test_timeout_defaults_to_fifty_milliseconds(self) -> None:
              assert build().cache_timeout_ms == 50
      ```

- [ ] **Step 4: Run the settings test and confirm it fails.**
      `cd services/tracking && pytest tests/test_settings.py::TestCacheSettings -q`
      Expected: 5 failures, each an `AttributeError: 'Settings' object has no attribute
      'cache_enabled'` (or `redis_host` / `redis_port` / `cache_timeout_ms`).

- [ ] **Step 5: Add the four settings fields.**
      In `services/tracking/src/shared/config/settings.py`, insert a new block immediately
      after the `metrics_enabled: bool = True` field and before the
      `# --- E2E test harness ---` comment:
      ```python
      # --- response cache (Redis) ---------------------------------------------
      # The kill switch. ON by default so a real runtime caches without opting in;
      # `false` makes every cached route skip the cache entirely and emit NO
      # `X-Cache` header at all (not `BYPASS` — see shared/cache/gateway.py on why
      # the two must stay distinguishable). Two purposes: the load test's A/B
      # comparison, and an immediate out if the cache ever serves wrong data.
      cache_enabled: bool = True

      # Where the shared Redis/valkey lives. DEFAULTED, like `users_grpc_url`
      # above and for the same reason recorded there: `generate_env_files.py`
      # currently writes REDIS_HOST/REDIS_PORT only into `.env.local.users`, and
      # env files are generated rather than hand-edited ([[env-files]]), so a
      # required field would refuse to start this service for a reason living in
      # `infra/**`. The default is the compose service name — exactly what the
      # generator emits — so local behaviour is identical either way.
      redis_host: str = Field(default="redis", min_length=1)
      redis_port: int = Field(default=6379, gt=0, lt=65536)

      # Per-operation budget, in milliseconds. The cache exists to make a read
      # faster; an operation slower than this has already lost its own argument,
      # so it is abandoned and the request falls through to MySQL with
      # `X-Cache: BYPASS`.
      cache_timeout_ms: int = Field(default=50, gt=0)
      ```

- [ ] **Step 6: Run the settings test and confirm it passes.**
      `cd services/tracking && pytest tests/test_settings.py -q`
      Expected: all tests pass, including the pre-existing ones (the new keys are cleared by
      the `clean_env` autouse fixture, so a developer's shell cannot leak in).

- [ ] **Step 7: Commit.**
      `git add services/tracking/requirements.txt services/tracking/requirements-runtime.txt
      services/tracking/src/shared/config/settings.py services/tracking/tests/test_settings.py
      && git commit -m "feat(tracking): add Redis cache settings and the redis dependency"`

---

#### Part B — cache keys

- [ ] **Step 8: Write the failing key-builder test.**
      Create `services/tracking/tests/test_cache_keys.py`:
      ```python
      """The cache key builders.

      No database and no Redis: these are pure functions, and the only reason they
      have their own file is that the rules they encode (skip when `user_id` is
      unresolved; normalize a list before hashing it) are the two ways a caching
      layer silently serves the wrong body.
      """

      from src.shared.cache.keys import CacheKeys

      SUB_A = "11111111-1111-4111-8111-111111111111"
      SUB_B = "22222222-2222-4222-8222-222222222222"
      USER_A = "usr_aaaaaaaaaaaaaaaaaaaaa"
      USER_B = "usr_bbbbbbbbbbbbbbbbbbbbb"


      class TestSingleTrackingKey:
          def test_carries_both_identities_and_the_order_id(self) -> None:
              key = CacheKeys.tracking_order(SUB_A, USER_A, "ord_1")
              assert key == f"tracking:order:v1:{SUB_A}:{USER_A}:ord_1"

          def test_two_users_never_share_a_key(self) -> None:
              assert CacheKeys.tracking_order(SUB_A, USER_A, "ord_1") != (
                  CacheKeys.tracking_order(SUB_B, USER_B, "ord_1")
              )

          def test_unresolved_user_id_means_NO_key(self) -> None:
              """`user_id` is legitimately None for an authenticated caller.

              `log_identity._resolve_quietly` swallows UnknownUserError, RpcError and
              anything else, so a perfectly valid caller can reach a handler with no
              internal id. Embedding "None" in the key would give every such caller a
              SHARED key — a cross-user leak dressed as a cache hit. The builder
              answers None and the route skips caching for that request.
              """
              assert CacheKeys.tracking_order(SUB_A, None, "ord_1") is None


      class TestListKey:
          def test_normalizes_before_hashing(self) -> None:
              """Two orderings of the same set are ONE key, not two."""
              assert CacheKeys.tracking_list(SUB_A, USER_A, ["b", "a"]) == (
                  CacheKeys.tracking_list(SUB_A, USER_A, ["a", "b"])
              )

          def test_deduplicates_before_hashing(self) -> None:
              assert CacheKeys.tracking_list(SUB_A, USER_A, ["a", "a", "b"]) == (
                  CacheKeys.tracking_list(SUB_A, USER_A, ["a", "b"])
              )

          def test_different_sets_are_different_keys(self) -> None:
              assert CacheKeys.tracking_list(SUB_A, USER_A, ["a", "b"]) != (
                  CacheKeys.tracking_list(SUB_A, USER_A, ["a", "c"])
              )

          def test_carries_the_prefix_and_both_identities(self) -> None:
              key = CacheKeys.tracking_list(SUB_A, USER_A, ["a"])
              assert key is not None
              assert key.startswith(f"tracking:list:v1:{SUB_A}:{USER_A}:")

          def test_hash_is_fixed_length_regardless_of_input_size(self) -> None:
              """The whole point of hashing: 100 ids must not make a 100-id key."""
              small = CacheKeys.tracking_list(SUB_A, USER_A, ["a"])
              large = CacheKeys.tracking_list(
                  SUB_A, USER_A, [f"ord_{n}" for n in range(100)]
              )
              assert small is not None and large is not None
              assert len(small) == len(large)

          def test_unresolved_user_id_means_NO_key(self) -> None:
              assert CacheKeys.tracking_list(SUB_A, None, ["a"]) is None


      class TestIdentityKey:
          def test_is_keyed_on_the_sub_alone(self) -> None:
              """It is the thing that RESOLVES user_id, so it cannot contain one."""
              assert CacheKeys.identity(SUB_A) == f"identity:sub-to-user:v1:{SUB_A}"


      class TestUserIndexKey:
          def test_names_the_user_whose_keys_it_holds(self) -> None:
              assert CacheKeys.user_index(SUB_A, USER_A) == (
                  f"tracking:index:v1:{SUB_A}:{USER_A}"
              )


      class TestPrefixExtraction:
          def test_stops_at_the_version_segment(self) -> None:
              """Telemetry gets the prefix ONLY — never the sub or the user id."""
              key = f"tracking:order:v1:{SUB_A}:{USER_A}:ord_1"
              assert CacheKeys.prefix_of(key) == "tracking:order:v1"

          def test_prefix_of_an_identity_key(self) -> None:
              assert CacheKeys.prefix_of(CacheKeys.identity(SUB_A)) == (
                  "identity:sub-to-user:v1"
              )
      ```

- [ ] **Step 9: Run it and confirm it fails.**
      `cd services/tracking && pytest tests/test_cache_keys.py -q`
      Expected: a collection error — `ModuleNotFoundError: No module named 'src.shared.cache'`.

- [ ] **Step 10: Create the cache package.**
      `mkdir -p services/tracking/src/shared/cache` and write
      `services/tracking/src/shared/cache/__init__.py`:
      ```python
      """The HTTP response cache and the identity-mapping cache.

      Four pieces, matching the shared design ([[response-caching-layer-design]]):

      * `keys.py`      — key construction, and the rules that keep a key from being
                         shared between two callers.
      * `gateway.py`   — the transport: Redis, JSON, the 50ms budget, and the
                         metric/span/log emission for every operation.
      * `identity_cache.py` — the `cognito_sub -> user_id` mapping, which must be
                         resolved BEFORE a response key can be built.
      * `invalidation.py`   — what the carrier webhook deletes after its write lands.

      Governing rule for all four: **the cache may never break or degrade a read.**
      Every Redis touch is wrapped, timed and swallowed; a failure answers
      `X-Cache: BYPASS` and the request proceeds against MySQL.
      """

      from .gateway import CacheEntry, CacheGateway, NullCacheGateway
      from .identity_cache import IdentityCache
      from .invalidation import invalidate_tracking
      from .keys import CacheKeys

      __all__ = [
          "CacheEntry",
          "CacheGateway",
          "CacheKeys",
          "IdentityCache",
          "NullCacheGateway",
          "invalidate_tracking",
      ]
      ```
      > **Note:** this `__init__` imports modules created in Steps 11, 15, 24 and 34. Until
      > Step 34 lands, `pytest tests/test_cache_keys.py` would fail on those imports. So write
      > the `__init__.py` body **now** but comment out every line except the `keys` import and
      > `"CacheKeys"`, uncommenting each as its module appears. The alternative — importing
      > `src.shared.cache.keys` directly in the tests — is what the test file above already
      > does, so the tests themselves are unaffected either way.

- [ ] **Step 11: Implement the key builders.**
      Write `services/tracking/src/shared/cache/keys.py`:
      ```python
      """Cache key construction.

      Every response key carries BOTH identities — `cognito_sub` and `user_id`.
      `cognito_sub` is the ownership key every user-scoped read filters by
      (`services/tracking/CLAUDE.md` §5b); `user_id` is the internal `usr_` id. Both
      travel so a key is unambiguous under either identity model, and so the
      per-user index below can be reconstructed from either.

      ## Why a builder may answer `None`

      `user_id` is resolved lazily, over gRPC to Users, and that resolution is
      allowed to fail: `log_identity._resolve_quietly` swallows `UnknownUserError`,
      `grpc.RpcError` and everything else, because enriching a log line must never
      fail a request. So a fully authenticated caller can reach a handler with
      `user_id is None`.

      Formatting that `None` into a key would produce the literal string
      `tracking:order:v1:<sub>:None:<order_id>` — which is a DIFFERENT key per sub,
      so it does not leak across users by itself. But the `None` segment is a lie
      about what the entry is scoped by, and the per-user index keyed on the same
      `None` would collapse. Answering `None` instead makes the route skip caching
      for that request entirely: it pays a MISS, serves from MySQL, and writes
      nothing. A request that cannot be keyed correctly is not cached at all.

      ## Why the list key is a hash

      `order_ids` is an arbitrary caller-supplied list of up to
      `MAX_BATCH_ORDER_IDS` (100) ids. Keying on the raw list would make the key
      length proportional to the request and the key SPACE combinatorial. Sorting
      and deduplicating first, then hashing, collapses every ordering and every
      repetition of one set onto one fixed-length key — which is both a
      cardinality bound and a hit-rate improvement, since two clients asking for
      the same orders in different orders now share an entry.
      """

      from __future__ import annotations

      import hashlib

      #: Bumped when a cached DTO's shape changes, which mass-invalidates every
      #: entry of that shape without touching Redis: the old keys simply stop being
      #: read and expire on their own TTL.
      VERSION = "v1"

      #: The number of colon-separated segments that make up a key's PREFIX — the
      #: only part of a key that may appear in a span attribute, a metric dimension
      #: or a log line. Everything after it is identity.
      _PREFIX_SEGMENTS = 3


      class CacheKeys:
          """Namespace for the key builders. No state; never instantiated."""

          @staticmethod
          def tracking_order(
              cognito_sub: str, user_id: str | None, order_id: str
          ) -> str | None:
              """Key for `GET /v1/trackings/{order_id}`, or None if unkeyable."""
              if not user_id:
                  return None
              return f"tracking:order:{VERSION}:{cognito_sub}:{user_id}:{order_id}"

          @staticmethod
          def tracking_list(
              cognito_sub: str, user_id: str | None, order_ids: list[str]
          ) -> str | None:
              """Key for `GET /v1/trackings?order_ids=`, or None if unkeyable.

              Normalizes (sort + dedup) BEFORE hashing, so `?order_ids=b,a` and
              `?order_ids=a,b,a` are one key.
              """
              if not user_id:
                  return None
              digest = _hash_order_ids(order_ids)
              return f"tracking:list:{VERSION}:{cognito_sub}:{user_id}:{digest}"

          @staticmethod
          def identity(cognito_sub: str) -> str:
              """Key for the `cognito_sub -> user_id` mapping.

              Never `None`: this is the cache consulted to OBTAIN a `user_id`, so it
              cannot require one. Keyed on the sub alone.
              """
              return f"identity:sub-to-user:{VERSION}:{cognito_sub}"

          @staticmethod
          def user_index(cognito_sub: str, user_id: str) -> str:
              """Key of the Redis SET holding this user's live response keys.

              Required because a list key embeds a HASH of an arbitrary id list and
              therefore cannot be reconstructed at invalidation time. `KEYS` and
              `SCAN` are the wrong answer: both are O(N) over the whole keyspace,
              and `KEYS` blocks the server while it runs.
              """
              return f"tracking:index:{VERSION}:{cognito_sub}:{user_id}"

          @staticmethod
          def prefix_of(key: str) -> str:
              """The telemetry-safe prefix: everything up to and including `v1`.

              A full key carries `cognito_sub` and `user_id`. A span is an export
              destination like any other, and a CloudWatch dimension VALUE is
              cardinality the account is billed for, so neither ever sees more than
              this.
              """
              return ":".join(key.split(":")[:_PREFIX_SEGMENTS])


      def _hash_order_ids(order_ids: list[str]) -> str:
          """Normalize then hash: sorted, deduplicated, newline-joined, sha256.

          `sorted(set(...))` is the normalization; the newline join is a separator
          that cannot appear inside an order id, so `["ab", "c"]` and `["a", "bc"]`
          cannot collide. Truncated to 16 hex characters — 64 bits, which for a
          keyspace of at most a few million live list entries makes a collision
          negligible, while keeping the key short enough to read in `redis-cli`.

          sha256 rather than `hash()`: Python's built-in string hash is salted per
          process (PYTHONHASHSEED), so two replicas would compute DIFFERENT keys for
          the same request and the cache would never hit across them.
          """
          normalized = "\n".join(sorted(set(order_ids)))
          return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
      ```

- [ ] **Step 12: Run the key test and confirm it passes.**
      `cd services/tracking && pytest tests/test_cache_keys.py -q`
      Expected: `15 passed`.

- [ ] **Step 13: Commit.**
      `git add services/tracking/src/shared/cache services/tracking/tests/test_cache_keys.py
      && git commit -m "feat(tracking): add cache key builders with list normalization"`

---

#### Part C — the gateway (transport, timeout, telemetry)

- [ ] **Step 14: Write the failing gateway test.**
      Create `services/tracking/tests/test_cache_gateway.py`:
      ```python
      """The cache transport: JSON round trip, TTL, the index, and fail-open.

      Uses `fakeredis`, not a real server — see the rationale in requirements.txt.
      The failure tests use a client whose every method raises, which is what a
      timeout or a dropped connection looks like from this code's side.
      """

      from typing import Any

      import fakeredis
      import pytest

      from src.shared.cache.gateway import CacheGateway
      from src.shared.metrics.cloudwatch_metrics import NoopMetricsPublisher


      class ExplodingRedis:
          """Every operation fails, exactly as an unreachable Redis does."""

          def get(self, *args: Any, **kwargs: Any) -> Any:
              raise ConnectionError("redis is down")

          def setex(self, *args: Any, **kwargs: Any) -> Any:
              raise ConnectionError("redis is down")

          def delete(self, *args: Any, **kwargs: Any) -> Any:
              raise ConnectionError("redis is down")

          def ttl(self, *args: Any, **kwargs: Any) -> Any:
              raise ConnectionError("redis is down")

          def sadd(self, *args: Any, **kwargs: Any) -> Any:
              raise ConnectionError("redis is down")

          def smembers(self, *args: Any, **kwargs: Any) -> Any:
              raise ConnectionError("redis is down")

          def pipeline(self, *args: Any, **kwargs: Any) -> Any:
              raise ConnectionError("redis is down")


      class RecordingPublisher:
          """Captures every metric datum, so a test can assert on dimensions."""

          def __init__(self) -> None:
              self.data: list[tuple[str, float, dict[str, str]]] = []

          def publish(
              self, name: str, value: float, dimensions: dict[str, str]
          ) -> None:
              self.data.append((name, value, dimensions))


      @pytest.fixture
      def redis_double() -> fakeredis.FakeRedis:
          return fakeredis.FakeRedis(decode_responses=True)


      @pytest.fixture
      def gateway(redis_double: fakeredis.FakeRedis) -> CacheGateway:
          return CacheGateway(
              client=redis_double, metrics=NoopMetricsPublisher()
          )


      class TestRoundTrip:
          def test_miss_on_an_unknown_key(self, gateway: CacheGateway) -> None:
              entry = gateway.get("tracking:order:v1:s:u:ord_1")
              assert entry.hit is False
              assert entry.bypassed is False
              assert entry.value is None
              assert entry.ttl_remaining is None

          def test_set_then_get_returns_the_value(
              self, gateway: CacheGateway
          ) -> None:
              gateway.set(
                  "tracking:order:v1:s:u:ord_1", {"status": "SHIPPED"}, 60
              )
              entry = gateway.get("tracking:order:v1:s:u:ord_1")
              assert entry.hit is True
              assert entry.value == {"status": "SHIPPED"}

          def test_hit_reports_the_remaining_ttl(
              self, gateway: CacheGateway
          ) -> None:
              gateway.set("tracking:order:v1:s:u:ord_1", {"a": 1}, 60)
              entry = gateway.get("tracking:order:v1:s:u:ord_1")
              assert entry.ttl_remaining is not None
              assert 0 < entry.ttl_remaining <= 60

          def test_nested_structures_survive_the_round_trip(
              self, gateway: CacheGateway
          ) -> None:
              """The cached body is a whole TrackingResponse, history included."""
              body = {
                  "id": "trk_1",
                  "history": [{"status": "PLACED"}, {"status": "SHIPPED"}],
              }
              gateway.set("tracking:order:v1:s:u:ord_1", body, 60)
              assert gateway.get("tracking:order:v1:s:u:ord_1").value == body


      class TestInvalidate:
          def test_removes_the_key(self, gateway: CacheGateway) -> None:
              gateway.set("tracking:order:v1:s:u:ord_1", {"a": 1}, 60)
              gateway.invalidate("tracking:order:v1:s:u:ord_1")
              assert gateway.get("tracking:order:v1:s:u:ord_1").hit is False

          def test_deleting_an_absent_key_is_not_an_error(
              self, gateway: CacheGateway
          ) -> None:
              gateway.invalidate("tracking:order:v1:s:u:nope")

          def test_no_keys_is_a_no_op(self, gateway: CacheGateway) -> None:
              gateway.invalidate()


      class TestUserIndex:
          def test_set_with_an_index_records_the_key(
              self, gateway: CacheGateway, redis_double: fakeredis.FakeRedis
          ) -> None:
              gateway.set(
                  "tracking:list:v1:s:u:abcd",
                  {"trackings": []},
                  60,
                  index_key="tracking:index:v1:s:u",
              )
              assert redis_double.smembers("tracking:index:v1:s:u") == {
                  "tracking:list:v1:s:u:abcd"
              }

          def test_invalidate_index_removes_every_member_and_the_index(
              self, gateway: CacheGateway, redis_double: fakeredis.FakeRedis
          ) -> None:
              index = "tracking:index:v1:s:u"
              gateway.set("tracking:list:v1:s:u:aaa", {"n": 1}, 60, index_key=index)
              gateway.set("tracking:list:v1:s:u:bbb", {"n": 2}, 60, index_key=index)

              gateway.invalidate_index(index)

              assert gateway.get("tracking:list:v1:s:u:aaa").hit is False
              assert gateway.get("tracking:list:v1:s:u:bbb").hit is False
              assert redis_double.smembers(index) == set()

          def test_invalidating_an_empty_index_is_not_an_error(
              self, gateway: CacheGateway
          ) -> None:
              gateway.invalidate_index("tracking:index:v1:s:nobody")


      class TestFailOpen:
          """Redis being down must produce a BYPASS, never an exception."""

          @pytest.fixture
          def broken(self) -> CacheGateway:
              return CacheGateway(
                  client=ExplodingRedis(), metrics=NoopMetricsPublisher()
              )

          def test_get_bypasses(self, broken: CacheGateway) -> None:
              entry = broken.get("tracking:order:v1:s:u:ord_1")
              assert entry.bypassed is True
              assert entry.hit is False
              assert entry.value is None

          def test_set_swallows(self, broken: CacheGateway) -> None:
              broken.set("tracking:order:v1:s:u:ord_1", {"a": 1}, 60)

          def test_invalidate_swallows(self, broken: CacheGateway) -> None:
              broken.invalidate("tracking:order:v1:s:u:ord_1")

          def test_invalidate_index_swallows(self, broken: CacheGateway) -> None:
              broken.invalidate_index("tracking:index:v1:s:u")

          def test_a_corrupt_payload_is_a_miss_not_a_crash(
              self, gateway: CacheGateway, redis_double: fakeredis.FakeRedis
          ) -> None:
              """Someone else's key, a truncated write, a version skew."""
              redis_double.set("tracking:order:v1:s:u:ord_1", "{not json")
              assert gateway.get("tracking:order:v1:s:u:ord_1").hit is False


      class TestMetrics:
          def test_a_hit_publishes_the_PREFIX_never_the_full_key(self) -> None:
              publisher = RecordingPublisher()
              gateway = CacheGateway(
                  client=fakeredis.FakeRedis(decode_responses=True),
                  metrics=publisher,
              )
              key = "tracking:order:v1:secret-sub:usr_secret:ord_1"
              gateway.set(key, {"a": 1}, 60)
              gateway.get(key)

              requests = [d for d in publisher.data if d[0] == "cache_requests_total"]
              assert requests, "cache_requests_total was never published"
              name, value, dimensions = requests[-1]
              assert value == 1
              assert dimensions["Service"] == "tracking"
              assert dimensions["Result"] == "hit"
              assert dimensions["KeyPrefix"] == "tracking:order:v1"
              assert "secret-sub" not in str(dimensions)
              assert "usr_secret" not in str(dimensions)

          def test_a_miss_publishes_result_miss(self) -> None:
              publisher = RecordingPublisher()
              gateway = CacheGateway(
                  client=fakeredis.FakeRedis(decode_responses=True),
                  metrics=publisher,
              )
              gateway.get("tracking:list:v1:s:u:abcd")
              assert publisher.data[0][2]["Result"] == "miss"

          def test_a_bypass_publishes_result_bypass(self) -> None:
              publisher = RecordingPublisher()
              gateway = CacheGateway(
                  client=ExplodingRedis(), metrics=publisher
              )
              gateway.get("tracking:order:v1:s:u:ord_1")
              results = [d[2]["Result"] for d in publisher.data if d[0] ==
                         "cache_requests_total"]
              assert results == ["bypass"]

          def test_duration_is_published_per_operation(self) -> None:
              publisher = RecordingPublisher()
              gateway = CacheGateway(
                  client=fakeredis.FakeRedis(decode_responses=True),
                  metrics=publisher,
              )
              gateway.set("tracking:order:v1:s:u:ord_1", {"a": 1}, 60)
              gateway.get("tracking:order:v1:s:u:ord_1")

              durations = [
                  d for d in publisher.data if d[0] == "cache_operation_duration_ms"
              ]
              operations = {d[2]["Operation"] for d in durations}
              assert operations == {"get", "set"}
              assert all(d[2]["Service"] == "tracking" for d in durations)
      ```

- [ ] **Step 15: Run it and confirm it fails.**
      `cd services/tracking && pytest tests/test_cache_gateway.py -q`
      Expected: a collection error — `ModuleNotFoundError: No module named
      'src.shared.cache.gateway'`.

- [ ] **Step 16: Implement the gateway.**
      Write `services/tracking/src/shared/cache/gateway.py`:
      ```python
      """The cache transport: Redis, JSON, the timeout budget, and telemetry.

      Everything that touches Redis in this service goes through here, and every
      method here obeys one rule: **it never raises.** A `get` that fails answers a
      bypassed `CacheEntry`; a `set` or an `invalidate` that fails logs and returns.
      A cache is an optimization, and an optimization that can fail a request is a
      liability.

      ## Why manual spans and not an instrumentation package

      `opentelemetry-instrumentation-redis` exists, and it is deliberately NOT
      installed. `requirements-runtime.txt` records why: every `-instrumentation-*`
      package lives on the 0.x train and hard-pins its siblings, so adding one drags
      the whole train and can only move in lockstep with the 1.x SDK. The spans this
      class emits by hand carry more than the auto-instrumentation would anyway —
      `cache.result` and `cache.ttl_remaining` are business facts, not transport
      facts, and no instrumentation can know them.

      ## Why the full key never leaves this module

      Every response key embeds `cognito_sub` and `user_id`. A span attribute, a
      CloudWatch dimension value and a log field are all export destinations, so all
      three receive `CacheKeys.prefix_of(key)` and nothing more. The rule is
      enforced by there being exactly one place — this file — that holds both the key
      and a telemetry call.
      """

      from __future__ import annotations

      import json
      import logging
      import time
      from dataclasses import dataclass
      from typing import Any, Protocol

      from opentelemetry import trace
      from opentelemetry.trace import SpanKind

      from src.shared.cache.keys import CacheKeys
      from src.shared.metrics.cloudwatch_metrics import (
          SERVICE_DIMENSION,
          MetricsPublisher,
      )

      logger = logging.getLogger(__name__)

      #: Own tracer, named for its area — the same convention as
      #: `shared/observability/workflow_tracing.py`'s `tracking-workflow` and
      #: `shared/metrics/cloudwatch_metrics.py`'s `tracking-metrics`.
      _tracer = trace.get_tracer("tracking-cache")

      REQUESTS_METRIC = "cache_requests_total"
      DURATION_METRIC = "cache_operation_duration_ms"

      RESULT_HIT = "hit"
      RESULT_MISS = "miss"
      RESULT_BYPASS = "bypass"


      class RedisLike(Protocol):
          """The subset of the `redis` client API this gateway uses.

          A Protocol rather than the concrete `redis.Redis` so `fakeredis` (and the
          deliberately-broken double in the tests) satisfy it without inheritance.
          """

          def get(self, name: str) -> Any: ...
          def setex(self, name: str, time: int, value: str) -> Any: ...
          def delete(self, *names: str) -> Any: ...
          def ttl(self, name: str) -> Any: ...
          def sadd(self, name: str, *values: str) -> Any: ...
          def smembers(self, name: str) -> Any: ...


      @dataclass(frozen=True, slots=True)
      class CacheEntry:
          """The outcome of a `get`.

          Three states, and `bypassed` is why there are three rather than two: a
          MISS means "Redis answered, and had nothing", a BYPASS means "Redis did not
          answer". Collapsing them would make an outage read as a poor hit rate on
          the dashboard, which is the one reading that would send an operator to
          look at the wrong system.
          """

          hit: bool
          value: Any | None = None
          ttl_remaining: int | None = None
          bypassed: bool = False


      class CacheGateway:
          """Reads, writes and invalidates cache entries. Never raises."""

          def __init__(
              self, *, client: RedisLike, metrics: MetricsPublisher
          ) -> None:
              self._client = client
              self._metrics = metrics

          # ------------------------------------------------------------- read
          def get(self, key: str) -> CacheEntry:
              """Look up `key`. Returns a MISS, a HIT, or a BYPASS — never raises."""
              prefix = CacheKeys.prefix_of(key)
              started = time.perf_counter()
              with _tracer.start_as_current_span(
                  "cache.get",
                  kind=SpanKind.CLIENT,
                  attributes={"cache.key_prefix": prefix},
              ) as span:
                  try:
                      raw = self._client.get(key)
                      if raw is None:
                          span.set_attribute("cache.result", RESULT_MISS)
                          self._record(RESULT_MISS, prefix, "get", started)
                          return CacheEntry(hit=False)
                      value = json.loads(raw)
                      ttl = self._read_ttl(key)
                      span.set_attribute("cache.result", RESULT_HIT)
                      if ttl is not None:
                          span.set_attribute("cache.ttl_remaining", ttl)
                      self._record(RESULT_HIT, prefix, "get", started)
                      return CacheEntry(hit=True, value=value, ttl_remaining=ttl)
                  except (ValueError, TypeError):
                      # A payload Redis returned but JSON could not parse: a
                      # truncated write, a key someone else wrote, a shape from a
                      # version that predates a `v1` bump. Treated as a MISS, not a
                      # BYPASS — Redis is fine, the ENTRY is not, so the right
                      # answer is to recompute and overwrite it.
                      span.set_attribute("cache.result", RESULT_MISS)
                      logger.warning(
                          "cache_entry_unreadable",
                          extra={
                              "app_event": "cache_entry_unreadable",
                              "reason": "malformed_payload",
                              "cache_key_prefix": prefix,
                          },
                      )
                      self._record(RESULT_MISS, prefix, "get", started)
                      return CacheEntry(hit=False)
                  except Exception:  # noqa: BLE001 - the cache never fails a read
                      span.set_attribute("cache.result", RESULT_BYPASS)
                      self._warn_unavailable("get", prefix)
                      self._record(RESULT_BYPASS, prefix, "get", started)
                      return CacheEntry(hit=False, bypassed=True)

          # ------------------------------------------------------------ write
          def set(
              self,
              key: str,
              value: Any,
              ttl_seconds: int,
              *,
              index_key: str | None = None,
          ) -> None:
              """Store `value` under `key` for `ttl_seconds`. Never raises.

              `index_key`, when given, names the per-user SET this key is recorded
              in, so a later invalidation can find it without `KEYS`/`SCAN`. The SET
              is given a TTL of its own, comfortably longer than the entries it
              tracks, so an index for a user who stops reading expires instead of
              accumulating forever.
              """
              prefix = CacheKeys.prefix_of(key)
              started = time.perf_counter()
              with _tracer.start_as_current_span(
                  "cache.set",
                  kind=SpanKind.CLIENT,
                  attributes={
                      "cache.key_prefix": prefix,
                      "cache.ttl_remaining": ttl_seconds,
                  },
              ):
                  try:
                      self._client.setex(key, ttl_seconds, json.dumps(value))
                      if index_key is not None:
                          self._client.sadd(index_key, key)
                          # Deliberately longer than any entry it indexes: an index
                          # that expired FIRST would leave orphaned entries no
                          # invalidation could ever reach, and they would then serve
                          # stale data for the remainder of their own TTL.
                          self._client.setex  # noqa: B018 - see the two lines below
                          self._expire(index_key, INDEX_TTL_SECONDS)
                  except Exception:  # noqa: BLE001 - a write failure is invisible
                      self._warn_unavailable("set", prefix)
                  finally:
                      self._record(None, prefix, "set", started)

          def invalidate(self, *keys: str) -> None:
              """Delete `keys`. Never raises; deleting an absent key is fine."""
              if not keys:
                  return
              prefix = CacheKeys.prefix_of(keys[0])
              started = time.perf_counter()
              with _tracer.start_as_current_span(
                  "cache.invalidate",
                  kind=SpanKind.CLIENT,
                  attributes={
                      "cache.key_prefix": prefix,
                      "cache.key_count": len(keys),
                  },
              ):
                  try:
                      self._client.delete(*keys)
                  except Exception:  # noqa: BLE001 - see the module docstring
                      self._warn_unavailable("invalidate", prefix)
                  finally:
                      self._record(None, prefix, "invalidate", started)

          def invalidate_index(self, index_key: str) -> None:
              """Delete every key the index names, then the index itself.

              This is the answer to "the list key embeds a hash I cannot
              reconstruct". `KEYS`/`SCAN` would be the other answer and is the wrong
              one: both are O(N) over the entire keyspace, `KEYS` blocks the server
              for the duration, and neither is acceptable on a write path.
              """
              prefix = CacheKeys.prefix_of(index_key)
              started = time.perf_counter()
              with _tracer.start_as_current_span(
                  "cache.invalidate_index",
                  kind=SpanKind.CLIENT,
                  attributes={"cache.key_prefix": prefix},
              ) as span:
                  try:
                      members = self._client.smembers(index_key) or set()
                      span.set_attribute("cache.key_count", len(members))
                      if members:
                          self._client.delete(*members)
                      self._client.delete(index_key)
                  except Exception:  # noqa: BLE001 - see the module docstring
                      self._warn_unavailable("invalidate_index", prefix)
                  finally:
                      self._record(None, prefix, "invalidate_index", started)

          # --------------------------------------------------------- internals
          def _read_ttl(self, key: str) -> int | None:
              """Seconds left on `key`, or None when Redis will not say.

              Redis answers `-1` for a key with no expiry and `-2` for one that no
              longer exists; neither is a duration, so both become None and the
              caller simply omits `X-Cache-TTL`.
              """
              try:
                  ttl = int(self._client.ttl(key))
              except Exception:  # noqa: BLE001 - the TTL is decoration on a HIT
                  return None
              return ttl if ttl > 0 else None

          def _expire(self, key: str, seconds: int) -> None:
              """Refresh an index's own lifetime, tolerating a client without it."""
              expire = getattr(self._client, "expire", None)
              if expire is not None:
                  expire(key, seconds)

          def _warn_unavailable(self, operation: str, prefix: str) -> None:
              """One WARN per failed operation, with a machine-readable reason.

              `app_event=cache_unavailable` is the token the shared design names,
              and it is what a dashboard alerts on. `exc_info` is deliberately off:
              a Redis outage produces one of these per request, and a stack trace
              per request buries every other signal in the stream.
              """
              logger.warning(
                  "cache_unavailable",
                  extra={
                      "app_event": "cache_unavailable",
                      "reason": "redis_unavailable",
                      "cache_operation": operation,
                      "cache_key_prefix": prefix,
                  },
              )

          def _record(
              self, result: str | None, prefix: str, operation: str, started: float
          ) -> None:
              """Publish the two metrics for one operation.

              Goes through the CloudWatch publisher, not an OTel `Meter`: this
              service runs no OTel metrics pipeline (`OTEL_METRICS_EXPORTER=none` in
              the generated env), and standing one up across three runtimes is its
              own milestone. The publisher's contract is that it NEVER raises, so
              there is no try/except here — adding one would duplicate a guarantee
              the Protocol already makes.
              """
              elapsed_ms = (time.perf_counter() - started) * 1000
              if result is not None:
                  self._metrics.publish(
                      REQUESTS_METRIC,
                      1,
                      {
                          "Service": SERVICE_DIMENSION,
                          "KeyPrefix": prefix,
                          "Result": result,
                      },
                  )
              self._metrics.publish(
                  DURATION_METRIC,
                  elapsed_ms,
                  {"Service": SERVICE_DIMENSION, "Operation": operation},
              )


      class NullCacheGateway:
          """The binding used when `CACHE_ENABLED=false`.

          Not a gateway with a flag inside it: a null object means the routes have
          exactly one code path, and "the cache is off" is expressed by which object
          is bound rather than by a branch in every handler. Its `get` returns a
          plain MISS with `bypassed=False`, and the routes read `cache_enabled` to
          decide whether to emit a header at all — so a disabled cache emits NO
          `X-Cache` header, never `MISS` and never `BYPASS`.
          """

          def get(self, key: str) -> CacheEntry:
              return CacheEntry(hit=False)

          def set(
              self,
              key: str,
              value: Any,
              ttl_seconds: int,
              *,
              index_key: str | None = None,
          ) -> None:
              return None

          def invalidate(self, *keys: str) -> None:
              return None

          def invalidate_index(self, index_key: str) -> None:
              return None


      #: How long a per-user index SET lives. Longer than any entry it tracks (the
      #: longest response TTL here is 60s) so the index can never expire out from
      #: under keys it is the only way to reach; short enough that a user who stops
      #: reading does not leave a SET behind forever.
      INDEX_TTL_SECONDS = 3600
      ```
      Then fix the stray line flagged in the comment: delete the
      `self._client.setex  # noqa: B018` line from `set` — it is a leftover no-op;
      `self._expire(index_key, INDEX_TTL_SECONDS)` on the following line is the real call.
      Also move the `INDEX_TTL_SECONDS = 3600` definition up, directly under `RESULT_BYPASS`,
      so it is defined before `set` runs.

- [ ] **Step 17: Run the gateway test and confirm it passes.**
      `cd services/tracking && pytest tests/test_cache_gateway.py -q`
      Expected: `20 passed`.

- [ ] **Step 18: Write the Redis client factory.**
      Write `services/tracking/src/shared/cache/redis_client.py`:
      ```python
      """The process-wide Redis client and the gateway built on it.

      Lazy, not module-level, so importing this module neither opens a socket nor
      requires a valid environment — the same rule `users_client.py`,
      `db/engine.py` and `cloudwatch_metrics.py` all follow.

      The `lru_cache` is keyed on PRIMITIVES, never on `Settings`. Pydantic's
      `BaseSettings` is unhashable, so an `lru_cache` taking a settings object
      raises `TypeError` on its first call — and that failure is invisible to a
      suite that injects its own double everywhere. This repo has been bitten by it
      in three separate modules; see `_cached_client(target, api_key)` in
      `shared/grpc/users_client.py`, `_engines(writer_url, reader_url, echo)` in
      `shared/db/engine.py`, and `_cached_publisher(endpoint_url, region)` in
      `shared/metrics/cloudwatch_metrics.py`.
      """

      from __future__ import annotations

      from functools import lru_cache

      import redis

      from src.shared.cache.gateway import CacheGateway, NullCacheGateway
      from src.shared.config.settings import get_settings
      from src.shared.metrics.cloudwatch_metrics import shared_metrics_publisher


      @lru_cache(maxsize=1)
      def _cached_client(host: str, port: int, timeout_ms: int) -> redis.Redis:
          """One client (hence one connection pool) per process, keyed on values.

          `decode_responses=True` so `get` hands back `str` and `json.loads` needs no
          decode step. Both timeouts are the SAME budget: a connect that takes longer
          than the operation is allowed to take has already blown it, so there is no
          reason to give the two different numbers.

          `retry_on_timeout=False` is load-bearing rather than a default worth
          restating: a retry would spend the 50ms budget twice, turning the fail-open
          guarantee into a 100ms one on exactly the path the cache exists to speed up.
          """
          seconds = timeout_ms / 1000
          return redis.Redis(
              host=host,
              port=port,
              decode_responses=True,
              socket_timeout=seconds,
              socket_connect_timeout=seconds,
              retry_on_timeout=False,
          )


      def shared_cache_gateway() -> CacheGateway | NullCacheGateway:
          """The process-wide gateway, or the null object when the cache is off.

          The kill switch is applied HERE, at construction, rather than inside the
          gateway: with the cache disabled nothing should build a Redis client at
          all, so a service running with `CACHE_ENABLED=false` needs no reachable
          Redis to start.
          """
          settings = get_settings()
          if not settings.cache_enabled:
              return NullCacheGateway()
          client = _cached_client(
              settings.redis_host, settings.redis_port, settings.cache_timeout_ms
          )
          return CacheGateway(client=client, metrics=shared_metrics_publisher())
      ```

- [ ] **Step 19: Verify the module imports cleanly.**
      `cd services/tracking && python -c "from src.shared.cache.redis_client import
      shared_cache_gateway; print('ok')"`
      Expected: `ok` printed, and **no** connection attempt (the client is built lazily inside
      `shared_cache_gateway`, which this does not call).

- [ ] **Step 20: Lint and commit.**
      `cd services/tracking && ruff check src tests`
      Expected: `All checks passed!`. Then
      `git add services/tracking/src/shared/cache services/tracking/tests/test_cache_gateway.py
      && git commit -m "feat(tracking): add the Redis cache gateway with fail-open and telemetry"`

---

#### Part D — the identity cache

- [ ] **Step 21: Write the failing identity-cache test.**
      Create `services/tracking/tests/test_identity_cache.py`:
      ```python
      """The `cognito_sub -> user_id` cache.

      This one is consulted BEFORE a response key can be built, because every
      response key carries `user_id`. A hit here removes the gRPC call to Users from
      the critical path of what should be a fast read.
      """

      import fakeredis
      import pytest

      from src.shared.cache.gateway import CacheGateway
      from src.shared.cache.identity_cache import IdentityCache
      from src.shared.metrics.cloudwatch_metrics import NoopMetricsPublisher

      SUB_A = "11111111-1111-4111-8111-111111111111"
      USER_A = "usr_aaaaaaaaaaaaaaaaaaaaa"


      class CountingLoader:
          """The gRPC resolution, counted so a hit is provable by absence."""

          def __init__(self, answer: str | None) -> None:
              self.answer = answer
              self.calls = 0

          def __call__(self) -> str | None:
              self.calls += 1
              return self.answer


      @pytest.fixture
      def cache() -> IdentityCache:
          return IdentityCache(
              gateway=CacheGateway(
                  client=fakeredis.FakeRedis(decode_responses=True),
                  metrics=NoopMetricsPublisher(),
              )
          )


      class TestResolve:
          def test_a_miss_calls_the_loader_and_returns_its_answer(
              self, cache: IdentityCache
          ) -> None:
              loader = CountingLoader(USER_A)
              assert cache.resolve(SUB_A, loader) == USER_A
              assert loader.calls == 1

          def test_a_second_resolve_does_NOT_call_the_loader(
              self, cache: IdentityCache
          ) -> None:
              """The whole point: no gRPC call on the second request."""
              loader = CountingLoader(USER_A)
              cache.resolve(SUB_A, loader)
              assert cache.resolve(SUB_A, loader) == USER_A
              assert loader.calls == 1

          def test_a_None_answer_is_NOT_cached(self, cache: IdentityCache) -> None:
              """An unresolvable sub must stay unresolvable, not stick for an hour.

              A `None` here means Users had no record, or Users was unreachable, or
              no client could be built. Caching that for the 1h TTL would keep a
              user's own `user_id` out of their keys long after the cause cleared —
              and since a `None` user_id disables caching entirely (see
              `CacheKeys`), it would silently switch the cache off for that caller
              for an hour. So negatives are re-asked every request; the cost is the
              gRPC call they would have paid anyway.
              """
              loader = CountingLoader(None)
              assert cache.resolve(SUB_A, loader) is None
              assert cache.resolve(SUB_A, loader) is None
              assert loader.calls == 2

          def test_two_subs_do_not_share_an_entry(self, cache: IdentityCache) -> None:
              other = "22222222-2222-4222-8222-222222222222"
              cache.resolve(SUB_A, CountingLoader(USER_A))
              loader = CountingLoader("usr_bbbbbbbbbbbbbbbbbbbbb")
              assert cache.resolve(other, loader) == "usr_bbbbbbbbbbbbbbbbbbbbb"

          def test_stored_with_the_one_hour_ttl(self, cache: IdentityCache) -> None:
              cache.resolve(SUB_A, CountingLoader(USER_A))
              entry = cache._gateway.get(f"identity:sub-to-user:v1:{SUB_A}")
              assert entry.ttl_remaining is not None
              assert 3500 < entry.ttl_remaining <= 3600


      class TestFailOpen:
          def test_a_dead_redis_still_resolves_through_the_loader(self) -> None:
              class ExplodingRedis:
                  def __getattr__(self, name: str):  # noqa: ANN202
                      def boom(*args: object, **kwargs: object) -> None:
                          raise ConnectionError("redis is down")

                      return boom

              cache = IdentityCache(
                  gateway=CacheGateway(
                      client=ExplodingRedis(), metrics=NoopMetricsPublisher()
                  )
              )
              loader = CountingLoader(USER_A)
              assert cache.resolve(SUB_A, loader) == USER_A
              assert loader.calls == 1

          def test_a_loader_that_raises_yields_None_not_an_exception(
              self, cache: IdentityCache
          ) -> None:
              """`resolve_internal_user_id` raises UnknownUserError on an unknown sub."""

              def boom() -> str | None:
                  raise RuntimeError("users is down")

              assert cache.resolve(SUB_A, boom) is None
      ```

- [ ] **Step 22: Run it and confirm it fails.**
      `cd services/tracking && pytest tests/test_identity_cache.py -q`
      Expected: a collection error — `ModuleNotFoundError: No module named
      'src.shared.cache.identity_cache'`.

- [ ] **Step 23: Implement the identity cache.**
      Write `services/tracking/src/shared/cache/identity_cache.py`:
      ```python
      """The `cognito_sub -> user_id` mapping cache.

      ## Why this exists at all

      Every response key carries `user_id` as well as `cognito_sub`. `user_id` is
      not on the request — it is an internal `usr_` id that only Users knows, and
      Tracking obtains it with a gRPC call. So building a response key requires
      resolving it FIRST, on every request, cache hit included. Without this,
      a "fast" cache hit would still pay a network round trip to another service,
      which is most of the latency the response cache was supposed to remove.

      ## Why TTL-only invalidation is correct here, not a gap

      A `cognito_sub` never resolves to a different `user_id` while the account
      exists, so a stale entry cannot serve a WRONG answer — only a late one. And
      there is no event in this repo that could trigger an early invalidation:
      Users' Cognito webhook accepts exactly two `triggerSource` values
      (`PostConfirmation_ConfirmSignUp`, `PostConfirmation_ConfirmForgotPassword`),
      neither of which is an identity change, and no account-deletion flow exists
      anywhere in the system. The 1h TTL bounds the one case this could get wrong —
      an account that has stopped existing — and when a deletion endpoint is built,
      deleting this key is part of THAT milestone's work.

      ## Negatives are never cached

      A `None` answer means one of: Users has no record, Users was unreachable, or
      no client could be built (`log_identity._resolve_quietly` collapses all three).
      Caching that would keep a real user's `user_id` out of their keys for an hour
      after the cause cleared — and because `CacheKeys` skips caching entirely when
      `user_id` is None, it would quietly disable the response cache for that caller
      for the whole hour. Re-asking each request costs exactly the call the request
      would have made anyway.
      """

      from __future__ import annotations

      import logging
      from collections.abc import Callable

      from src.shared.cache.gateway import CacheGateway, NullCacheGateway
      from src.shared.cache.keys import CacheKeys

      logger = logging.getLogger(__name__)

      #: One hour. Long, because the mapping is effectively immutable; bounded,
      #: because a deleted account is the one case where it could be wrong.
      IDENTITY_TTL_SECONDS = 3600


      class IdentityCache:
          """Resolves `cognito_sub -> user_id`, consulting Redis first."""

          def __init__(self, *, gateway: CacheGateway | NullCacheGateway) -> None:
              self._gateway = gateway

          def resolve(
              self, cognito_sub: str, loader: Callable[[], str | None]
          ) -> str | None:
              """The cached mapping, falling back to `loader` on a miss.

              `loader` is the expensive path — in practice
              `CurrentCaller.resolve_internal_user_id`, wrapped so its
              `UnknownUserError` becomes a `None`. It is allowed to raise; anything
              it raises is swallowed into `None`, because this whole mechanism is an
              optimization on top of an enrichment that was already documented never
              to fail a request.
              """
              key = CacheKeys.identity(cognito_sub)
              entry = self._gateway.get(key)
              if entry.hit and isinstance(entry.value, str) and entry.value:
                  return entry.value

              user_id = self._load(loader)
              if user_id:
                  self._gateway.set(key, user_id, IDENTITY_TTL_SECONDS)
              return user_id

          @staticmethod
          def _load(loader: Callable[[], str | None]) -> str | None:
              """Run the loader, turning ANY failure into `None`.

              Deliberately broad, and for the same reason
              `log_identity._resolve_quietly` is: a narrow `except` listing the
              foreseen failures is how that module broke the first time — the
              unforeseen one still `500`'d the request. `Exception`, not
              `BaseException`, so a `CancelledError` from a disconnecting client
              keeps propagating.
              """
              try:
                  return loader()
              except Exception:  # noqa: BLE001 - identity resolution never fails a read
                  logger.debug("identity_cache_loader_failed", exc_info=True)
                  return None
      ```

- [ ] **Step 24: Run the identity-cache test and confirm it passes.**
      `cd services/tracking && pytest tests/test_identity_cache.py -q`
      Expected: `8 passed`.

- [ ] **Step 25: Wire the identity cache into `stamp_caller_user_id`.**
      In `services/tracking/src/shared/http/log_identity.py`, replace the body of
      `stamp_caller_user_id` (at `:129`) so the resolution goes through the cache. Keep it
      `async def` and keep the `asyncio.to_thread` — both are load-bearing:
      ```python
      async def stamp_caller_user_id(
          cognito_sub: CallerSub, users: OptionalUsersClient
      ) -> CurrentCaller:
          caller = CurrentCaller(cognito_sub=cognito_sub, users=users)
          user_id = await asyncio.to_thread(_resolve_cached, caller)
          # Merged HERE, after the await, on the request's own context. A merge
          # inside the thread would land on the thread's COPY and be discarded —
          # the trap this repo has already been bitten by twice.
          merge_log_context(user_id=user_id)
          return caller
      ```
      and add, beside `_resolve_quietly`:
      ```python
      def _resolve_cached(caller: CurrentCaller) -> str | None:
          """`_resolve_quietly`, with the identity cache in front of it.

          Runs on a worker thread, like the call it wraps: the Redis client is the
          blocking sync API and so is the gRPC client, so neither may touch the
          event loop.

          The cache is built here rather than injected as a dependency for one
          reason: this function already runs on the thread, and building a gateway
          is a dictionary lookup into an `lru_cache`, not a connection. Injecting it
          would mean a second `Depends` on a path whose whole point is to add as
          little as possible.

          Two things stay exactly as they were. `_resolve_quietly` is still what
          runs on a miss, so every failure it swallows is still swallowed. And the
          result is still MEMOIZED ON THE CALLER by `CurrentCaller`, so a handler
          that resolves later in the same request pays nothing either way — the
          identity cache removes the cost across REQUESTS, `CurrentCaller` removes
          it within one.
          """
          from src.shared.cache.identity_cache import IdentityCache
          from src.shared.cache.redis_client import shared_cache_gateway

          try:
              cache = IdentityCache(gateway=shared_cache_gateway())
          except Exception:  # noqa: BLE001 - an unbuildable cache is not a failure
              # `shared_cache_gateway` reads `get_settings()`, which raises
              # `ValidationError` on an incomplete environment — the exact failure
              # `get_optional_users_client` above exists to absorb, and for the
              # exact same reason: 24 read tests build the app without those
              # variables.
              return _resolve_quietly(caller)
          return cache.resolve(caller.cognito_sub, lambda: _resolve_quietly(caller))
      ```
      > **Note:** the import is inside the function on purpose. `log_identity` is imported by
      > `trackings_router`, which is imported by `main.create_app`; a module-level import of
      > `redis_client` would pull `redis` and `get_settings` into that chain, and
      > `test_openapi_spec.py` builds the app **without a database or an environment**. A
      > local import keeps the app importable in exactly the contexts that already build it.

- [ ] **Step 26: Run the whole existing suite to prove nothing regressed.**
      `cd services/tracking && pytest -q`
      Expected: every previously-passing test still passes. In particular
      `tests/test_rest_reads.py` and `tests/test_openapi_spec.py` must be green — the first
      proves the identity path still resolves through the stub Users server, the second proves
      `create_app()` still imports with no environment at all.

- [ ] **Step 27: Commit.**
      `git add services/tracking/src/shared/cache services/tracking/src/shared/http/log_identity.py
      services/tracking/tests/test_identity_cache.py
      && git commit -m "feat(tracking): cache the cognito_sub to user_id mapping for 1h"`

---

#### Part E — the cached reads

- [ ] **Step 28: Add the `cache_result` log field.**
      In `services/tracking/src/shared/logging/log_context.py`, add to the `_ALLOWED_KEYS`
      frozenset (at `:46`), after `"request_id"`:
      ```python
              # `hit` | `miss` | `bypass` for a cached route. OMITTED, never null, on
              # a route that is not cached and on every route when
              # `CACHE_ENABLED=false` — `_clean` below drops a None, so a caller
              # merging `cache_result=None` costs nothing and adds no field.
              "cache_result",
      ```
      > **Note:** the brief describes `merge_log_context` as taking arbitrary `**fields`. It
      > does, but `_clean` (`log_context.py:104`) filters against this **fixed allowlist** —
      > a key not listed here is silently dropped. Without this step `cache_result` would
      > never reach a single log line, and nothing would fail: the field would just be absent.
      > **Trust the code.**

- [ ] **Step 29: Add the cache dependency seam.**
      Write `services/tracking/src/shared/http/cache_dependencies.py`:
      ```python
      """The FastAPI seam for the cache gateway.

      A dependency purely so tests can override it
      (`app.dependency_overrides[get_cache_gateway]`) with a gateway over an
      in-process fake — the same seam `get_read_session` / `get_write_session` /
      `get_users_client` give the database and Users.

      Plain `def`, not `async def`, and that is the correct choice here even though
      `stamp_caller_user_id` next door is `async def` for the opposite reason. The
      rule at `log_identity.py:36-49` is about the LOG CONTEXT: a `def` dependency
      runs in FastAPI's threadpool, which gets a COPY of the request's context, so a
      `merge_log_context` inside one is discarded on return. This dependency merges
      nothing — it returns an object. The handlers that consume it are themselves
      plain `def` (pymysql is a blocking driver), so they run in that same
      threadpool and a blocking Redis call inside them cannot stall the event loop.

      The routes DO merge `cache_result` into the log context, and they do it from
      inside the handler rather than from here, for exactly the reason above.
      """

      from __future__ import annotations

      from typing import Annotated

      from fastapi import Depends

      from src.shared.cache.gateway import CacheGateway, NullCacheGateway
      from src.shared.cache.redis_client import shared_cache_gateway


      def get_cache_gateway() -> CacheGateway | NullCacheGateway:
          """The process-wide gateway, or the null object when the cache is off.

          Resolved lazily, inside the function body, so importing this module
          neither opens a socket nor requires a valid environment — the same rule
          `get_users_client` follows.
          """
          return shared_cache_gateway()


      CacheGatewayDep = Annotated[
          CacheGateway | NullCacheGateway, Depends(get_cache_gateway)
      ]
      ```

- [ ] **Step 30: Add the test fixtures.**
      In `services/tracking/tests/conftest.py`, add `import fakeredis` to the import block,
      then add these two fixtures immediately before the `app` fixture (at `:343`):
      ```python
      @pytest.fixture
      def redis_double() -> fakeredis.FakeRedis:
          """An in-process Redis for the cache suite.

          A fake, not a real server, and deliberately: the DB fixtures hit real MySQL
          because a mock cannot catch a schema or driver bug, but a cache has neither
          a schema nor a dialect. `fakeredis` implements the exact client API this
          service calls, TTL semantics included, so the code under test is the
          production code path — while the suite keeps needing only MySQL to run.
          """
          return fakeredis.FakeRedis(decode_responses=True)


      @pytest.fixture
      def cache_gateway(redis_double: fakeredis.FakeRedis) -> CacheGateway:
          """A real `CacheGateway` over the fake, publishing metrics nowhere."""
          return CacheGateway(client=redis_double, metrics=NoopMetricsPublisher())
      ```
      with these imports at the top of the file:
      ```python
      from src.shared.cache.gateway import CacheGateway
      from src.shared.metrics.cloudwatch_metrics import NoopMetricsPublisher
      ```
      Then change the `app` fixture's signature to `def app(engine: Engine, cache_gateway:
      CacheGateway) -> FastAPI:` and add a fourth override beside the existing three (at
      `:392-395`):
      ```python
      from src.shared.http.cache_dependencies import get_cache_gateway
      ...
      application.dependency_overrides[get_cache_gateway] = lambda: cache_gateway
      ```
      Finally add `cache_enabled=True` to the `override_settings` `Settings(...)` call, so the
      routes' kill-switch read is explicit rather than inherited from a default.

- [ ] **Step 31: Write the failing cached-read tests.**
      Create `services/tracking/tests/test_cached_reads.py`:
      ```python
      """`GET /v1/trackings/{order_id}` and `GET /v1/trackings` behind the cache.

      Drives the REAL app through `TestClient` against real MySQL and a fake Redis —
      routing, dependencies, response models and headers all exercised, because a
      cache bug that only appears through the HTTP surface (a header stripped by a
      response model, a key built from the wrong dependency) is exactly the kind a
      direct function call cannot see.
      """

      import fakeredis
      import pytest
      from fastapi import FastAPI
      from fastapi.testclient import TestClient
      from sqlalchemy.orm import Session

      from src.shared.cache.gateway import CacheGateway
      from src.shared.http.cache_dependencies import get_cache_gateway
      from src.shared.http.caller import get_users_client
      from src.shared.metrics.cloudwatch_metrics import NoopMetricsPublisher
      from tests.test_rest_reads import SUB_A, SUB_B, USER_A, USER_B, as_user, seed

      pytestmark = pytest.mark.integration


      class StubResolver:
          """Stands in for the Users gRPC client, resolving sub -> usr_ id."""

          def __init__(self, mapping: dict[str, str]) -> None:
              self.mapping = mapping

          def resolve(self, identifier: str):  # noqa: ANN201 - a ResolvedUser or None
              from src.shared.grpc.users_client import ResolvedUser

              internal = self.mapping.get(identifier)
              if internal is None:
                  return None
              return ResolvedUser(
                  internal_id=internal,
                  cognito_sub=identifier,
                  email=None,
                  full_name="",
              )


      @pytest.fixture
      def resolving_app(app: FastAPI) -> FastAPI:
          """The app with identity resolution stubbed for BOTH test users.

          Without this, `_resolve_quietly` swallows the failure to reach Users and
          every caller arrives with `user_id is None` — which legitimately disables
          caching (see `CacheKeys`), so every assertion below would fail for a
          reason that has nothing to do with what it is testing.
          """
          app.dependency_overrides[get_users_client] = lambda: StubResolver(
              {SUB_A: USER_A, SUB_B: USER_B}
          )
          return app


      @pytest.fixture
      def resolving_client(resolving_app: FastAPI):  # noqa: ANN201
          with TestClient(resolving_app) as test_client:
              yield test_client


      class TestSingleReadCaching:
          def test_first_read_is_a_MISS_with_no_ttl_header(
              self, resolving_client: TestClient, session: Session
          ) -> None:
              seed(session, order_id="ord_cache0000000000001")
              response = resolving_client.get(
                  "/v1/trackings/ord_cache0000000000001", headers=as_user(SUB_A)
              )
              assert response.status_code == 200
              assert response.headers["x-cache"] == "MISS"
              assert "x-cache-ttl" not in response.headers

          def test_second_read_is_a_HIT_carrying_the_ttl(
              self, resolving_client: TestClient, session: Session
          ) -> None:
              seed(session, order_id="ord_cache0000000000002")
              url = "/v1/trackings/ord_cache0000000000002"
              first = resolving_client.get(url, headers=as_user(SUB_A))
              second = resolving_client.get(url, headers=as_user(SUB_A))

              assert second.headers["x-cache"] == "HIT"
              ttl = int(second.headers["x-cache-ttl"])
              assert 0 < ttl <= 60
              assert second.json() == first.json()

          def test_a_404_is_never_cached(
              self, resolving_client: TestClient, session: Session
          ) -> None:
              """Only 200s go in. A cached 404 would outlive the tracking's creation."""
              url = "/v1/trackings/ord_cache0000000000003"
              assert resolving_client.get(url, headers=as_user(SUB_A)).status_code == 404
              seed(session, order_id="ord_cache0000000000003")
              second = resolving_client.get(url, headers=as_user(SUB_A))
              assert second.status_code == 200


      class TestListReadCaching:
          def test_miss_then_hit(
              self, resolving_client: TestClient, session: Session
          ) -> None:
              seed(session, order_id="ord_cachelist00000001")
              url = "/v1/trackings?order_ids=ord_cachelist00000001"
              first = resolving_client.get(url, headers=as_user(SUB_A))
              second = resolving_client.get(url, headers=as_user(SUB_A))

              assert first.headers["x-cache"] == "MISS"
              assert "x-cache-ttl" not in first.headers
              assert second.headers["x-cache"] == "HIT"
              assert 0 < int(second.headers["x-cache-ttl"]) <= 60
              assert second.json() == first.json()

          def test_two_orderings_of_the_same_ids_share_ONE_entry(
              self, resolving_client: TestClient, session: Session
          ) -> None:
              """Normalization is what makes this a HIT rather than a second MISS."""
              seed(session, order_id="ord_cachelist00000002")
              seed(session, order_id="ord_cachelist00000003")

              forward = resolving_client.get(
                  "/v1/trackings?order_ids=ord_cachelist00000002,ord_cachelist00000003",
                  headers=as_user(SUB_A),
              )
              reversed_ = resolving_client.get(
                  "/v1/trackings?order_ids=ord_cachelist00000003,ord_cachelist00000002",
                  headers=as_user(SUB_A),
              )

              assert forward.headers["x-cache"] == "MISS"
              assert reversed_.headers["x-cache"] == "HIT"
              assert reversed_.json() == forward.json()

          def test_a_duplicate_id_hits_the_same_entry(
              self, resolving_client: TestClient, session: Session
          ) -> None:
              seed(session, order_id="ord_cachelist00000004")
              url = "/v1/trackings?order_ids=ord_cachelist00000004"
              resolving_client.get(url, headers=as_user(SUB_A))
              duplicated = resolving_client.get(
                  f"{url},ord_cachelist00000004", headers=as_user(SUB_A)
              )
              assert duplicated.headers["x-cache"] == "HIT"

          def test_the_over_cap_400_is_never_cached(
              self, resolving_client: TestClient
          ) -> None:
              ids = ",".join(f"ord_{n}" for n in range(101))
              response = resolving_client.get(
                  f"/v1/trackings?order_ids={ids}", headers=as_user(SUB_A)
              )
              assert response.status_code == 400
              assert response.headers.get("x-cache") != "HIT"


      class TestCrossUserIsolation:
          """NON-NEGOTIABLE: B must never receive A's cached body.

          This is the failure a response cache exists to be suspected of, and it is
          the one that a naive key (order_id only) produces immediately — with a
          200 and a plausible body, so nothing anywhere reports an error.
          """

          def test_B_gets_a_404_for_a_tracking_A_just_cached(
              self, resolving_client: TestClient, session: Session
          ) -> None:
              seed(
                  session,
                  order_id="ord_isolation00000001",
                  user_id=USER_A,
                  cognito_sub=SUB_A,
              )
              url = "/v1/trackings/ord_isolation00000001"

              a_response = resolving_client.get(url, headers=as_user(SUB_A))
              assert a_response.status_code == 200
              assert a_response.headers["x-cache"] == "MISS"

              b_response = resolving_client.get(url, headers=as_user(SUB_B))
              assert b_response.status_code == 404
              assert b_response.headers.get("x-cache") != "HIT"

          def test_B_does_not_inherit_A_s_cached_list(
              self, resolving_client: TestClient, session: Session
          ) -> None:
              seed(
                  session,
                  order_id="ord_isolation00000002",
                  user_id=USER_A,
                  cognito_sub=SUB_A,
              )
              url = "/v1/trackings?order_ids=ord_isolation00000002"

              a_response = resolving_client.get(url, headers=as_user(SUB_A))
              assert len(a_response.json()["trackings"]) == 1

              b_response = resolving_client.get(url, headers=as_user(SUB_B))
              assert b_response.headers["x-cache"] == "MISS"
              assert b_response.json()["trackings"] == []

          def test_B_reading_first_does_not_poison_A(
              self, resolving_client: TestClient, session: Session
          ) -> None:
              """The same isolation in the other direction — an empty body cached."""
              seed(
                  session,
                  order_id="ord_isolation00000003",
                  user_id=USER_A,
                  cognito_sub=SUB_A,
              )
              url = "/v1/trackings?order_ids=ord_isolation00000003"

              assert resolving_client.get(url, headers=as_user(SUB_B)).json()[
                  "trackings"
              ] == []
              a_response = resolving_client.get(url, headers=as_user(SUB_A))
              assert len(a_response.json()["trackings"]) == 1


      class TestUnresolvedIdentity:
          """A caller whose `user_id` cannot be resolved is served, never cached."""

          def test_read_succeeds_with_no_caching_when_user_id_is_unknown(
              self, app: FastAPI, session: Session
          ) -> None:
              """`app`, not `resolving_app`: nothing resolves this sub.

              `_resolve_quietly` swallows the failure, so the caller reaches the
              handler authenticated but with `user_id is None`. The read must still
              answer correctly; it simply is not cached, because a key with a `None`
              segment is not a key this service is willing to write.
              """
              seed(session, order_id="ord_nouserid000000001")
              with TestClient(app) as client:
                  url = "/v1/trackings/ord_nouserid000000001"
                  first = client.get(url, headers=as_user(SUB_A))
                  second = client.get(url, headers=as_user(SUB_A))

              assert first.status_code == 200
              assert first.headers["x-cache"] == "MISS"
              assert second.headers["x-cache"] == "MISS"


      class TestFailOpen:
          def test_a_dead_redis_answers_BYPASS_with_a_correct_body(
              self, resolving_app: FastAPI, session: Session
          ) -> None:
              class ExplodingRedis:
                  def __getattr__(self, name: str):  # noqa: ANN202
                      def boom(*args: object, **kwargs: object) -> None:
                          raise ConnectionError("redis is down")

                      return boom

              resolving_app.dependency_overrides[get_cache_gateway] = (
                  lambda: CacheGateway(
                      client=ExplodingRedis(), metrics=NoopMetricsPublisher()
                  )
              )
              order_id = seed(session, order_id="ord_bypass0000000001") and (
                  "ord_bypass0000000001"
              )
              with TestClient(resolving_app) as client:
                  response = client.get(
                      f"/v1/trackings/{order_id}", headers=as_user(SUB_A)
                  )

              assert response.status_code == 200
              assert response.headers["x-cache"] == "BYPASS"
              assert "x-cache-ttl" not in response.headers
              assert response.json()["order_id"] == order_id


      class TestKillSwitch:
          def test_CACHE_ENABLED_false_emits_NO_header_at_all(
              self, engine, redis_double: fakeredis.FakeRedis, session: Session
          ) -> None:
              """Not BYPASS and not MISS — absent. A disabled cache is invisible."""
              from sqlalchemy.orm import sessionmaker

              from src.main import create_app
              from src.shared.cache.gateway import NullCacheGateway
              from src.shared.config.settings import Settings, get_settings
              from src.shared.http.dependencies import (
                  get_read_session,
                  get_write_session,
              )
              from tests.conftest import TEST_CARRIER_API_KEY

              factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

              def override_read():  # noqa: ANN202
                  db = factory()
                  try:
                      yield db
                  finally:
                      db.close()

              application = create_app()
              application.dependency_overrides[get_read_session] = override_read
              application.dependency_overrides[get_write_session] = override_read
              application.dependency_overrides[get_settings] = lambda: Settings(
                  database_writer_url="mysql+pymysql://unused/unused",
                  database_reader_url="mysql+pymysql://unused/unused",
                  grpc_api_key="unused-grpc-key",
                  tracking_carrier_api_key=TEST_CARRIER_API_KEY,
                  cache_enabled=False,
              )
              application.dependency_overrides[get_cache_gateway] = (
                  lambda: NullCacheGateway()
              )
              application.dependency_overrides[get_users_client] = lambda: StubResolver(
                  {SUB_A: USER_A}
              )

              seed(session, order_id="ord_killswitch0000001")
              with TestClient(application) as client:
                  response = client.get(
                      "/v1/trackings/ord_killswitch0000001", headers=as_user(SUB_A)
                  )

              assert response.status_code == 200
              assert "x-cache" not in response.headers
              assert "x-cache-ttl" not in response.headers
              assert redis_double.keys("*") == []
      ```

- [ ] **Step 32: Run it and confirm it fails.**
      `cd services/tracking && pytest tests/test_cached_reads.py -q`
      Expected: a collection error — `ImportError: cannot import name 'get_cache_gateway' from
      'src.shared.http.cache_dependencies'` if Step 29 was skipped, otherwise the tests
      collect and fail with `KeyError: 'x-cache'` on every assertion — the routes emit no such
      header yet.

- [ ] **Step 33: Make both reads cached.**
      Rewrite the two handlers in
      `services/tracking/src/features/tracking/api/trackings_router.py`. Add these imports at
      the top, beside the existing ones:
      ```python
      from fastapi import Response

      from src.shared.cache.keys import CacheKeys
      from src.shared.config.settings import Settings, get_settings
      from src.shared.http.cache_dependencies import CacheGatewayDep
      from src.shared.logging import merge_log_context
      ```
      and a `Settings` dependency annotation plus the shared helper, after `NOT_FOUND_REASON`:
      ```python
      from typing import Annotated as _Annotated  # already imported as Annotated

      SettingsDep = Annotated[Settings, Depends(get_settings)]

      #: Both reads carry the same TTL: a tracking advances through the carrier
      #: webhook, which invalidates explicitly, so the TTL is only the safety net
      #: bounding how long a MISSED invalidation could serve stale data.
      READ_TTL_SECONDS = 60


      def _serve_cached(
          response: Response,
          cache: CacheGatewayDep,
          settings: SettingsDep,
          key: str | None,
      ) -> dict | None:
          """Consult the cache and stamp the response headers. Returns the body, or None.

          Three outcomes, and the header is the only place they are distinguishable
          to a client:

          * `HIT`    — a body, plus `X-Cache-TTL`. The handler does not run.
          * `MISS`   — no body. The handler runs; `_store_cached` writes the result.
          * `BYPASS` — no body, and Redis was unreachable. Kept distinct from MISS so
            an outage does not read as a poor hit rate on the dashboard.

          `key is None` means the caller's `user_id` could not be resolved, so no key
          can be built (see `CacheKeys`). That is a MISS with no write — the read is
          served correctly and simply is not cached.

          With `CACHE_ENABLED=false` this returns None and stamps NOTHING: a disabled
          cache emits no header at all, which is what makes the load test's A/B run
          comparable — the control arm looks exactly like a service with no cache.
          """
          if not settings.cache_enabled:
              return None
          if key is None:
              response.headers["X-Cache"] = "MISS"
              merge_log_context(cache_result="miss")
              return None

          entry = cache.get(key)
          if entry.bypassed:
              response.headers["X-Cache"] = "BYPASS"
              merge_log_context(cache_result="bypass")
              return None
          if entry.hit:
              response.headers["X-Cache"] = "HIT"
              if entry.ttl_remaining is not None:
                  response.headers["X-Cache-TTL"] = str(entry.ttl_remaining)
              merge_log_context(cache_result="hit")
              return entry.value
          response.headers["X-Cache"] = "MISS"
          merge_log_context(cache_result="miss")
          return None


      def _store_cached(
          cache: CacheGatewayDep,
          settings: SettingsDep,
          key: str | None,
          index_key: str | None,
          body: BaseModel,
      ) -> None:
          """Write a successful response into the cache. Only ever called on a 200.

          Reached only after the handler returned normally, so a `404`, a `400` and
          a `401` — each of which raises — can never get here. That is deliberately
          structural rather than a status check: a status check is something a future
          branch can forget to update, while an exception simply never arrives.

          `body.model_dump(mode="json")` and not `.dict()`: the response carries
          `datetime` fields, and `mode="json"` is what renders them as the ISO
          strings `json.dumps` can serialize — without it the gateway's
          `json.dumps` raises `TypeError`, which it swallows, and the entry is
          silently never written.
          """
          if not settings.cache_enabled or key is None:
              return
          cache.set(
              key,
              body.model_dump(mode="json"),
              READ_TTL_SECONDS,
              index_key=index_key,
          )
      ```
      Then change `get_trackings` (at `:164`) to take `response: Response` and the two new
      dependencies, and to consult the cache before the span opens:
      ```python
      def get_trackings(
          caller: IdentifiedCaller,
          session: ReadSession,
          response: Response,
          cache: CacheGatewayDep,
          settings: SettingsDep,
          order_ids: Annotated[str, Query(description=...)],
      ) -> TrackingListResponse:
          parsed = _parse_order_ids(order_ids)
          user_id = caller.resolved_internal_user_id
          key = CacheKeys.tracking_list(caller.cognito_sub, user_id, parsed)

          cached = _serve_cached(response, cache, settings, key)
          if cached is not None:
              # Validated back through the response model rather than returned raw:
              # a stored entry written by an older deployment could have a shape this
              # version no longer serves, and a validation error here is caught by
              # the gateway's own JSON guard on the next read. Returning the model
              # also means FastAPI serializes it exactly as it does a fresh one, so
              # a HIT and a MISS are byte-identical bodies.
              return TrackingListResponse.model_validate(cached)

          with workflow_span(...) as span:
              ...  # unchanged: the cap check, the query, the span attributes
              result = TrackingListResponse(trackings=[...])

          _store_cached(
              cache,
              settings,
              key,
              CacheKeys.user_index(caller.cognito_sub, user_id) if user_id else None,
              result,
          )
          return result
      ```
      and `get_tracking` (at `:255`) the same way:
      ```python
      def get_tracking(
          caller: IdentifiedCaller,
          session: ReadSession,
          response: Response,
          cache: CacheGatewayDep,
          settings: SettingsDep,
          order_id: Annotated[str, Path(description="The order's id")],
      ) -> TrackingResponse:
          user_id = caller.resolved_internal_user_id
          key = CacheKeys.tracking_order(caller.cognito_sub, user_id, order_id)

          cached = _serve_cached(response, cache, settings, key)
          if cached is not None:
              return TrackingResponse.model_validate(cached)

          with workflow_span(...) as span:
              ...  # unchanged: the query, the 404 branch, the span attributes
              result = TrackingResponse.from_entity(found.tracking, found.history)

          _store_cached(
              cache,
              settings,
              key,
              CacheKeys.user_index(caller.cognito_sub, user_id) if user_id else None,
              result,
          )
          return result
      ```
      > **Note — why `resolved_internal_user_id` and not `resolve_internal_user_id()`.**
      > `caller.py:100` documents the property as making **no network call**, returning `None`
      > when resolution has not happened. It HAS happened: `stamp_caller_user_id`
      > (`log_identity.py:154`) awaits the resolution before the handler runs, and
      > `CurrentCaller` memoizes it. So the property is the right read here — it is the already-
      > resolved value. Calling the METHOD instead would raise `UnknownUserError` on an
      > unresolvable caller, turning a 200 into a 500 on a path the service currently serves
      > fine, which is exactly the regression the "skip caching when unresolved" rule prevents.
      >
      > **Note — the `RejectedStatusUpdate` handler and `Response`.** Injecting `Response`
      > into a `def` handler makes FastAPI pass a real `Response` object whose headers are
      > merged into the final one. That merge does **not** happen when the handler raises: an
      > `HTTPException` produces a fresh response from the exception handler. That is the
      > correct behaviour and it is what makes `test_the_over_cap_400_is_never_cached` and
      > `test_a_404_is_never_cached` pass — a failure carries no `X-Cache` header, and the
      > tests assert `!= "HIT"` rather than absence for exactly that reason.

- [ ] **Step 34: Run the cached-read tests and confirm they pass.**
      `cd services/tracking && pytest tests/test_cached_reads.py -q`
      Expected: `13 passed`.

- [ ] **Step 35: Run the pre-existing read suite to prove nothing regressed.**
      `cd services/tracking && pytest tests/test_rest_reads.py -q`
      Expected: all pass. `TestFlowLogging` in that file asserts the handlers stay QUIET on the
      happy path — `merge_log_context` adds a context field rather than emitting a line, so it
      does not break that assertion, but confirm rather than assume.

- [ ] **Step 36: Regenerate the OpenAPI spec.**
      From the repo root:
      `docker compose run --rm --no-deps -e E2E_TESTING_ENABLED=true -v "$PWD/services/tracking:/app"
      --entrypoint python tracking scripts/generate_openapi.py`
      Expected: the command writes `services/tracking/openapi.yaml`. `git diff --stat
      services/tracking/openapi.yaml` should show a small diff at most — `Response`,
      `CacheGatewayDep` and `SettingsDep` are all non-body dependencies, so the request and
      response schemas are unchanged. If the diff is empty, that is the correct outcome, not a
      failed generation.

- [ ] **Step 37: Run the spec test and confirm it passes.**
      `cd services/tracking && pytest tests/test_openapi_spec.py -q`
      Expected: `passed`. This test regenerates and compares, so a stale committed spec fails
      here rather than reaching a consumer.

- [ ] **Step 38: Lint and commit.**
      `cd services/tracking && ruff check src tests`
      Expected: `All checks passed!`. Then
      `git add services/tracking/src services/tracking/tests services/tracking/openapi.yaml
      && git commit -m "feat(tracking): cache both user-scoped reads behind the X-Cache header"`

---

#### Part F — invalidation from the carrier webhook

This is the hardest correctness detail in the task, and it has two independent problems.

**Problem 1 — the webhook does not know who the owner is.** `carrier_router.py`'s router
(`:60`) declares `dependencies=[CarrierAuth]` and the handler (`:83-87`) takes only
`session`, `payload` and `order_id`. There is **no caller dependency of any kind**: this
endpoint authenticates with `x-api-key` and receives no `x-user-id` (the gateway route is
declared `auth = false`). So to delete a key shaped
`tracking:order:v1:{sub}:{user_id}:{order_id}`, the sub must come from the **tracking row
itself**. It already does: `update_tracking_status` returns the `Tracking` entity
(`update_status.py:74-80`), `Tracking.cognito_sub` exists (`domain/models.py:102`) and is
already read at `update_status.py:218` for the event envelope. The `tracking` variable at
`carrier_router.py:115` therefore carries it.

**Problem 2 — where the commit actually happens, and why the handler is the wrong place to
invalidate.** The transaction is **not** committed by `update_tracking_status` and **not** by
the handler. `get_write_session` (`dependencies.py:34-41`) is a generator dependency wrapping
`write_session()` (`engine.py:107-121`), whose body is `yield session; session.commit()`.
FastAPI resumes a generator dependency only **after** the handler has returned and the
response has been produced. So at every point inside `update_status`, including its last line,
**the write has not landed yet**.

Invalidating there would open exactly the window the shared design forbids: between the
`DELETE` and the `COMMIT`, a concurrent read misses, queries MySQL, reads the **pre-update**
row (its transaction cannot see the uncommitted change), and writes that stale body back
under the key that was just cleared — where it then sits for a full 60 s TTL, describing a
shipment that has already moved on. This is not theoretical; it is precisely why the design
says invalidation happens **after** the write persists, never before.

**The seam.** Register the invalidation as a `BackgroundTask` on the response. Starlette runs
background tasks after the response is sent, which is after every dependency's teardown has
run — so after `session.commit()`. That ordering is a property of the ASGI response cycle, not
a timing hope. `_store_cached` in Part E does not need this treatment because it runs on a
read, where there is nothing to order against.

- [ ] **Step 39: Write the failing invalidation tests.**
      Create `services/tracking/tests/test_cache_invalidation.py`:
      ```python
      """The carrier webhook clears the cache — after its transaction commits.

      The single-tracking key is easy: the webhook knows the `order_id` and reads the
      owner's sub off the row it just wrote. The LIST keys are not: each embeds a
      sha256 of an arbitrary caller-supplied id list, which cannot be reconstructed
      from anything the webhook holds. Those are cleared through the per-user index.
      """

      import pytest
      from fastapi import FastAPI
      from fastapi.testclient import TestClient
      from sqlalchemy.orm import Session

      from src.shared.http.caller import get_users_client
      from tests.conftest import TEST_CARRIER_API_KEY
      from tests.test_cached_reads import StubResolver
      from tests.test_rest_reads import SUB_A, USER_A, as_user, seed

      pytestmark = pytest.mark.integration


      def carrier_headers() -> dict[str, str]:
          return {"x-api-key": TEST_CARRIER_API_KEY}


      @pytest.fixture
      def resolving_app(app: FastAPI) -> FastAPI:
          app.dependency_overrides[get_users_client] = lambda: StubResolver(
              {SUB_A: USER_A}
          )
          return app


      @pytest.fixture
      def resolving_client(resolving_app: FastAPI):  # noqa: ANN201
          with TestClient(resolving_app) as test_client:
              yield test_client


      class TestSingleKeyInvalidation:
          def test_a_status_update_evicts_the_owner_s_single_read(
              self, resolving_client: TestClient, session: Session
          ) -> None:
              order_id = "ord_inval00000000001"
              seed(session, order_id=order_id)
              url = f"/v1/trackings/{order_id}"

              resolving_client.get(url, headers=as_user(SUB_A))
              assert (
                  resolving_client.get(url, headers=as_user(SUB_A)).headers["x-cache"]
                  == "HIT"
              )

              update = resolving_client.put(
                  f"/v1/trackings/{order_id}/status",
                  json={"status": "PROCESSING"},
                  headers=carrier_headers(),
              )
              assert update.status_code == 200

              after = resolving_client.get(url, headers=as_user(SUB_A))
              assert after.headers["x-cache"] == "MISS"
              assert after.json()["status"] == "PROCESSING"

          def test_a_REJECTED_update_leaves_the_cache_alone(
              self, resolving_client: TestClient, session: Session
          ) -> None:
              """Nothing was written, so nothing is stale. The HIT must survive.

              This is the assertion that catches invalidating from the wrong place:
              an eviction wired before the guards would fire on a 400 too, quietly
              costing a hit rate for a write that never happened.
              """
              order_id = "ord_inval00000000002"
              seed(session, order_id=order_id)
              url = f"/v1/trackings/{order_id}"

              resolving_client.get(url, headers=as_user(SUB_A))
              rejected = resolving_client.put(
                  f"/v1/trackings/{order_id}/status",
                  json={"status": "PLACED"},
                  headers=carrier_headers(),
              )
              assert rejected.status_code == 400

              assert (
                  resolving_client.get(url, headers=as_user(SUB_A)).headers["x-cache"]
                  == "HIT"
              )

          def test_a_404_update_invalidates_nothing(
              self, resolving_client: TestClient
          ) -> None:
              missing = resolving_client.put(
                  "/v1/trackings/ord_nosuchtracking001/status",
                  json={"status": "SHIPPED"},
                  headers=carrier_headers(),
              )
              assert missing.status_code == 404


      class TestListKeyInvalidation:
          def test_a_status_update_evicts_the_owner_s_LIST_keys(
              self, resolving_client: TestClient, session: Session
          ) -> None:
              """The keys the webhook cannot reconstruct, cleared via the index."""
              order_id = "ord_invallist0000001"
              other = "ord_invallist0000002"
              seed(session, order_id=order_id)
              seed(session, order_id=other)

              one = f"/v1/trackings?order_ids={order_id}"
              both = f"/v1/trackings?order_ids={order_id},{other}"
              resolving_client.get(one, headers=as_user(SUB_A))
              resolving_client.get(both, headers=as_user(SUB_A))
              assert (
                  resolving_client.get(both, headers=as_user(SUB_A)).headers["x-cache"]
                  == "HIT"
              )

              resolving_client.put(
                  f"/v1/trackings/{order_id}/status",
                  json={"status": "PROCESSING"},
                  headers=carrier_headers(),
              )

              # BOTH list keys go, not only the one naming the updated order: the
              # index holds keys, not the ids inside them, so the eviction is
              # per-user rather than per-order. Deliberately coarse — a 60s TTL
              # bounds the cost, and reconstructing which hashes contained the id
              # would need exactly the scan this index exists to avoid.
              assert (
                  resolving_client.get(one, headers=as_user(SUB_A)).headers["x-cache"]
                  == "MISS"
              )
              assert (
                  resolving_client.get(both, headers=as_user(SUB_A)).headers["x-cache"]
                  == "MISS"
              )


      class TestNullCognitoSub:
          """A tracking with no owner sub cannot have a per-user key to evict."""

          def test_the_update_succeeds_and_nothing_crashes(
              self, resolving_client: TestClient, session: Session
          ) -> None:
              """`cognito_sub` is NULLABLE (domain/models.py:102).

              A row created before the column existed, or created with `""` (which
              `create` normalizes to NULL), has no sub. Such a row is UNREACHABLE
              over the user-scoped reads — the ownership filter compares against a
              sub and NULL matches nobody — so it can have no cached entry, so
              there is nothing to invalidate. The update must still succeed.
              """
              order_id = "ord_nullsub000000001"
              seed(session, order_id=order_id, cognito_sub=None)

              response = resolving_client.put(
                  f"/v1/trackings/{order_id}/status",
                  json={"status": "PROCESSING"},
                  headers=carrier_headers(),
              )
              assert response.status_code == 200
              assert response.json()["status"] == "PROCESSING"

          def test_that_row_is_unreadable_so_it_was_never_cached(
              self, resolving_client: TestClient, session: Session
          ) -> None:
              seed(session, order_id="ord_nullsub000000002", cognito_sub=None)
              response = resolving_client.get(
                  "/v1/trackings/ord_nullsub000000002", headers=as_user(SUB_A)
              )
              assert response.status_code == 404


      class TestFailOpen:
          def test_a_dead_redis_does_not_fail_the_status_update(
              self, resolving_app: FastAPI, session: Session
          ) -> None:
              """The write is the important half; the eviction is best-effort."""
              from src.shared.cache.gateway import CacheGateway
              from src.shared.http.cache_dependencies import get_cache_gateway
              from src.shared.metrics.cloudwatch_metrics import NoopMetricsPublisher

              class ExplodingRedis:
                  def __getattr__(self, name: str):  # noqa: ANN202
                      def boom(*args: object, **kwargs: object) -> None:
                          raise ConnectionError("redis is down")

                      return boom

              resolving_app.dependency_overrides[get_cache_gateway] = (
                  lambda: CacheGateway(
                      client=ExplodingRedis(), metrics=NoopMetricsPublisher()
                  )
              )
              seed(session, order_id="ord_invalbypass00001")
              with TestClient(resolving_app) as client:
                  response = client.put(
                      "/v1/trackings/ord_invalbypass00001/status",
                      json={"status": "PROCESSING"},
                      headers=carrier_headers(),
                  )
              assert response.status_code == 200
      ```

- [ ] **Step 40: Run it and confirm it fails.**
      `cd services/tracking && pytest tests/test_cache_invalidation.py -q`
      Expected: `TestSingleKeyInvalidation::test_a_status_update_evicts_the_owner_s_single_read`
      fails with `assert 'HIT' == 'MISS'` (the stale entry is still served after the update),
      and `TestListKeyInvalidation` fails the same way. `TestNullCognitoSub` and `TestFailOpen`
      pass already — nothing invalidates yet, so nothing can crash.

- [ ] **Step 41: Implement the invalidator.**
      Write `services/tracking/src/shared/cache/invalidation.py`:
      ```python
      """What the carrier webhook clears, and what it can afford not to know.

      ## The webhook has no caller identity

      `PUT /v1/trackings/{order_id}/status` authenticates with `x-api-key` and
      receives no `x-user-id` at all — its gateway route is declared `auth = false`
      (`services/tracking/CLAUDE.md` §5a). So it cannot build a key carrying
      `{sub}:{user_id}` from the request. The owner comes off the PERSISTED ROW
      instead: `update_tracking_status` returns the `Tracking` entity, and
      `Tracking.cognito_sub` is the same value the reads' ownership filter compares
      against. That is the only identity in play here, and it is the right one.

      ## Why `user_id` is not needed to invalidate

      The single-read key embeds BOTH identities, but the webhook holds only the sub
      — the row carries a `user_id` too, and the two are read together, so the exact
      key IS reconstructible. The list keys are not, at any price: each embeds a
      sha256 of an arbitrary caller-supplied id list. Those are cleared through the
      per-user index (`CacheKeys.user_index`), a Redis SET the read path adds every
      list key to as it writes it.

      **Not `KEYS` and not `SCAN`.** Both are O(N) over the entire keyspace, `KEYS`
      blocks the server for the duration of the sweep, and putting either on a write
      path makes every carrier callback pay for the size of the whole cache.

      ## A NULL `cognito_sub` is a no-op, and that is safe

      The column is nullable (`domain/models.py:102`): a caller predating the field
      creates successfully, and `""` is normalized to NULL. Such a row is
      **unreachable** over both user-scoped reads — the filter compares against a
      sub, and NULL matches nobody, including the rightful owner. A row that can
      never be read can never have been cached, so there is no entry to evict. The
      function returns without touching Redis, and the status update proceeds.
      """

      from __future__ import annotations

      import logging

      from src.shared.cache.gateway import CacheGateway, NullCacheGateway
      from src.shared.cache.keys import CacheKeys

      logger = logging.getLogger(__name__)


      def invalidate_tracking(
          gateway: CacheGateway | NullCacheGateway,
          *,
          order_id: str,
          cognito_sub: str | None,
          user_id: str | None,
      ) -> None:
          """Evict everything a status change on `order_id` could have made stale.

          Never raises: the gateway swallows its own failures, and this adds no new
          failure mode of its own. A missed eviction costs at most the 60s TTL of
          the entries it failed to clear — which is precisely why the TTL is short.
          """
          if not cognito_sub:
              # See the module docstring: an unreachable row was never cached.
              logger.debug(
                  "cache_invalidation_skipped",
                  extra={
                      "app_event": "cache_invalidation_skipped",
                      "reason": "no_owner_sub",
                      "order_id": order_id,
                  },
              )
              return

          if user_id:
              key = CacheKeys.tracking_order(cognito_sub, user_id, order_id)
              if key is not None:
                  gateway.invalidate(key)
              gateway.invalidate_index(CacheKeys.user_index(cognito_sub, user_id))

          logger.info(
              "cache_invalidated",
              extra={
                  "app_event": "cache_invalidated",
                  "order_id": order_id,
                  "cognito_sub": cognito_sub,
              },
          )
      ```

- [ ] **Step 42: Schedule the invalidation after the commit.**
      In `services/tracking/src/features/tracking/api/carrier_router.py`, add these imports:
      ```python
      from fastapi import BackgroundTasks

      from src.shared.cache.invalidation import invalidate_tracking
      from src.shared.config.settings import Settings, get_settings
      from src.shared.http.cache_dependencies import CacheGatewayDep
      ```
      change the handler signature (`:83-87`) to:
      ```python
      def update_status(
          session: WriteSession,
          payload: UpdateStatusRequest,
          background: BackgroundTasks,
          cache: CacheGatewayDep,
          settings: Annotated[Settings, Depends(get_settings)],
          order_id: Annotated[str, Path(description="The order's id")],
      ) -> TrackingResponse:
      ```
      and, immediately after `span.set_attribute("status", tracking.status)` and before the
      `logger.info("carrier_status_update_succeeded", ...)` call, add:
      ```python
          # ---------------------------------------------------------------
          # Invalidation is scheduled, NOT executed here — and the ordering
          # is the whole point.
          #
          # This handler does not own the transaction. `get_write_session`
          # (shared/http/dependencies.py:34) is a GENERATOR dependency over
          # `write_session()` (shared/db/engine.py:107), whose body is
          # `yield session; session.commit()`. FastAPI resumes a generator
          # dependency only after the handler has returned and the response
          # has been produced. So at THIS line the update is written but not
          # committed.
          #
          # Deleting the key now would open exactly the window the design
          # forbids: between the DELETE and the COMMIT, a concurrent read
          # misses, queries MySQL, reads the PRE-update row (its transaction
          # cannot see an uncommitted change), and writes that stale body back
          # under the key just cleared — where it then serves a superseded
          # status for a full 60s TTL. Invalidating before the write lands is
          # worse than not invalidating at all, because it looks correct.
          #
          # A BackgroundTask runs after the response is sent, which is after
          # every dependency teardown, which is after `session.commit()`. That
          # ordering is a property of the ASGI response cycle, not a timing
          # hope. The identities come off the PERSISTED entity, never the
          # request — the carrier sends none.
          if settings.cache_enabled:
              background.add_task(
                  invalidate_tracking,
                  cache,
                  order_id=order_id,
                  cognito_sub=tracking.cognito_sub,
                  user_id=tracking.user_id,
              )
      ```
      > **Note — reading `tracking.cognito_sub` before the session closes.** Both attributes
      > are read at task-SCHEDULING time (they are evaluated as arguments to `add_task`), not
      > inside the task, so they are plain strings by the time the session is gone. Passing the
      > `Tracking` entity itself would be the bug: `write_session` closes the session in its
      > `finally` (`engine.py:120`), and touching a detached instance afterwards raises
      > `DetachedInstanceError`. `expire_on_commit=False` (`engine.py:99`) means already-loaded
      > attributes survive, but relying on that when two strings will do is a needless bet.
      >
      > **Note — the three failure branches need no guard.** Each of them (`ValueError`,
      > `TrackingNotFoundError`, `InvalidTransitionError`) raises out of the handler, so this
      > line is never reached and no task is scheduled. `write_session` rolls back on the
      > exception. That is what makes `test_a_REJECTED_update_leaves_the_cache_alone` pass, and
      > it is structural — there is no status check anyone can forget to update.

- [ ] **Step 43: Run the invalidation tests and confirm they pass.**
      `cd services/tracking && pytest tests/test_cache_invalidation.py -q`
      Expected: `8 passed`.
      > **Note:** `TestClient` runs background tasks synchronously before returning from the
      > `.put()` call, so the subsequent `.get()` in each test genuinely sees the post-
      > invalidation state. If a test flakes here, that assumption is what to check first —
      > `tests/conftest.py:400` already uses `TestClient` as a context manager specifically so
      > `BackgroundTasks` execute (its docstring says so, for the TestMode progression).

- [ ] **Step 44: Run the full suite.**
      `cd services/tracking && pytest -q`
      Expected: every test passes. Pay attention to `tests/test_testmode.py` (or whichever file
      drives the TestMode progression): it calls `update_tracking_status` directly rather than
      through the router, so it schedules no background task and needs no change — confirm
      that is what you observe rather than assuming it.

- [ ] **Step 45: Lint and regenerate the spec.**
      `cd services/tracking && ruff check src tests` → `All checks passed!`
      Then from the repo root:
      `docker compose run --rm --no-deps -e E2E_TESTING_ENABLED=true -v "$PWD/services/tracking:/app"
      --entrypoint python tracking scripts/generate_openapi.py`
      then `cd services/tracking && pytest tests/test_openapi_spec.py -q` → `passed`.
      Expected: no diff in `openapi.yaml` — `BackgroundTasks`, `CacheGatewayDep` and the
      `Settings` dependency are all non-body parameters FastAPI excludes from the schema.

- [ ] **Step 46: Commit.**
      `git add services/tracking/src services/tracking/tests services/tracking/openapi.yaml
      && git commit -m "feat(tracking): invalidate cached reads from the carrier webhook after commit"`

---

#### Part G — verification against the brief

- [ ] **Step 47: Confirm no full cache key can reach a span, a metric or a log.**
      `cd services/tracking && grep -rn "set_attribute(\"cache\|cache_key\|KeyPrefix" src/`
      Expected: every hit passes `CacheKeys.prefix_of(...)` or a variable named `prefix`, and
      no line passes a raw `key`. The only place both a full key and a telemetry call exist in
      one scope is `gateway.py`, and every call there uses `prefix`.

- [ ] **Step 48: Confirm the seven required behaviours each have a test.**
      `cd services/tracking && pytest tests/test_cache_keys.py tests/test_cache_gateway.py
      tests/test_identity_cache.py tests/test_cached_reads.py tests/test_cache_invalidation.py -v`
      Expected: all pass, and the named tests are present in the output —
      (1) `TestSingleReadCaching::test_first_read_is_a_MISS_with_no_ttl_header` +
      `test_second_read_is_a_HIT_carrying_the_ttl`;
      (2) `TestListReadCaching::test_miss_then_hit` +
      `test_two_orderings_of_the_same_ids_share_ONE_entry`;
      (3) `TestSingleKeyInvalidation::test_a_status_update_evicts_the_owner_s_single_read` +
      `TestListKeyInvalidation::test_a_status_update_evicts_the_owner_s_LIST_keys`;
      (4) `TestNullCognitoSub::test_the_update_succeeds_and_nothing_crashes`;
      (5) `TestCrossUserIsolation` — all three;
      (6) `TestFailOpen::test_a_dead_redis_answers_BYPASS_with_a_correct_body`;
      (7) `TestUnresolvedIdentity::test_read_succeeds_with_no_caching_when_user_id_is_unknown`
      plus `TestSingleTrackingKey::test_unresolved_user_id_means_NO_key`.

- [ ] **Step 49: Leave the work in the working tree.**
      Do not open a PR and do not merge. Report to the main session: the branch, the commits
      from Steps 7, 13, 20, 27, 38 and 46, and the full-suite result from Step 44. The main
      session presents the A/B/C/D/E confirmation menu.

      > **Out of scope for this task, and named so it is not mistaken for a gap:** the internal
      > and gateway E2E specs proving `X-Cache` survives nginx and the API Gateway, and the
      > Gatling A/B load scenario. Both are `e2e-impl`'s surface (`e2e/CLAUDE.md`) and belong
      > to their own tasks in this plan. The three-layer testing rule is satisfied at the
      > milestone level, not by this task alone — but a reviewer should confirm those tasks
      > exist before the milestone closes, because `X-Cache` is an unknown response header and
      > a gateway stripping it is invisible from the service port.

---
### Task 5: Users — the cached profile read and its invalidation

Users is the smallest of the three services in this milestone: **exactly one cached endpoint**,
`GET /v1/users/me`, keyed `users:me:v1:{cognito_sub}:{user_id}` with a 5-minute TTL.

**Users does NOT get an identity-mapping cache, and that is deliberate — do not add one.**
The `identity:sub-to-user:v1:{cognito_sub}` cache from the spec lives in Orders and Tracking
only, because those two must resolve `cognito_sub -> user_id` over a local DB query (Orders) or
a gRPC call to Users (Tracking) before they can build a response key. In Users the `user_id`
comes straight out of the authenticated query itself — `CurrentUser.resolve()` calls
`db.user.findByIdOrCognitoSub(identity)` (`services/users/src/shared/auth/current-user.ts:39`),
which is the *same* query `UserQueryService.getMe` needs anyway
(`services/users/src/features/users/queries/get-me.ts:34`). There is no separate resolution step
to cache. Spec wording, verbatim: "It does **not** live in Users, where `user_id` comes directly
from the authenticated query and needs no resolution."

**Files:**

- Create: `services/users/src/shared/cache/cache-gateway.ts`
- Create: `services/users/src/shared/cache/cache-keys.ts`
- Create: `services/users/src/features/users/http/cache-hooks.ts`
- Modify: `services/users/src/shared/config/env.ts` (nothing — `CACHE_ENABLED` lands in Task 1; this task only *reads* it)
- Modify: `services/users/src/shared/logging/log-context.ts` (add `cache_result` to `LogContextStore`)
- Modify: `services/users/src/shared/di/awilix-container.ts` (cradle type + `cacheGateway` registration)
- Modify: `services/users/src/shared/metrics/business-metrics.ts` (seed the two new cache counters with `0` per tick)
- Modify: `services/users/src/features/users/http/routes.ts` (attach the `preHandler`/`onSend` pair to `GET /v1/users/me`; invalidate on the three write routes)
- Modify: `services/users/src/features/users/http/e2e-cleanup.ts` (invalidate on E2E soft-delete)
- Test: `services/users/tests/shared/cache/cache-keys.test.ts`
- Test: `services/users/tests/shared/cache/cache-gateway.test.ts`
- Test: `services/users/tests/features/users/http/cache-hooks.test.ts`
- Test: `services/users/tests/shared/metrics/business-metrics.test.ts` (extend)
- Test: `services/users/tests/shared/di/cache-registrations.test.ts`

**Interfaces:**

Consumes (all verified in the working tree, do not re-derive):

- `createRedisClient(options: { host: string; port: number }): RedisClient` and
  `export type RedisClient = Redis` — `services/users/src/shared/cache/redis.ts:13,18`.
  Already registered as an Awilix SINGLETON at `awilix-container.ts:142-146`. **Reuse that
  registration; never construct a second ioredis client** — it holds a real TCP socket with its
  own reconnect state machine, and a second one leaks connections. It also carries the mandatory
  `client.on("error", ...)` handler (`redis.ts:45-50`): an ioredis `error` event with no listener
  is an unhandled `error` event, which kills the process.
- `MetricsPublisher.publish(name: string, value: number, dimensions: Record<string, string>, unit?: "Count" | "Milliseconds"): Promise<void>` — `services/users/src/shared/metrics/cloudwatch-metrics.ts:26-31`. Never rejects (logs `metric_publish_failed` and swallows). Namespace `3MRAI` (`:6`).
- `getHttpServerSpan(request: FastifyRequest): Span | undefined` — `services/users/src/shared/observability/request-span.ts:54`.
- `withHttpServerSpan<T>(request: FastifyRequest, fn: () => T): T` — `request-span.ts:79`.
- `setLogContext(fields: Partial<LogContextStore>): void` — `services/users/src/shared/logging/log-context.ts:51`.
- `appLogger` — `services/users/src/shared/logging/app-logger.ts`.
- `CurrentUser` with `readonly identity: string` (`current-user.ts:9`) and
  `resolve(): Promise<Row | null>` (`current-user.ts:18-22`, caches the *promise*).
- `serializeUser(user: User)` — `services/users/src/features/users/http/routes.ts:81-88` (module-private today; this task exports it).

Produces:

- `export function meCacheKey(cognitoSub: string, userId: string): string` — returns `users:me:v1:${cognitoSub}:${userId}`.
- `export const ME_KEY_PREFIX = "users:me:v1"` — the *prefix only*, the sole form allowed in metric dimensions and span attributes.
- `export interface CacheGetResult<T> { hit: boolean; value: T | undefined; ttlRemaining: number | undefined; bypass: boolean }`
- `export class CacheGateway` with
  `constructor(deps: { redis: RedisClient; metricsPublisher: MetricsPublisher; env: Env })`,
  `get<T>(key: string, keyPrefix: string): Promise<CacheGetResult<T>>`,
  `set(key: string, keyPrefix: string, value: unknown, ttlSeconds: number): Promise<void>`,
  `invalidate(keyPrefix: string, ...keys: string[]): Promise<void>`,
  and `readonly enabled: boolean`.
- `export function registerMeCacheHooks(app: FastifyInstance): void` — attaches the
  `preHandler` + `onSend` pair scoped to `GET /v1/users/me`.

---

- [ ] **Step 1: Write the failing key-builder test.**
  Create `services/users/tests/shared/cache/cache-keys.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { meCacheKey, ME_KEY_PREFIX } from "#shared/cache/cache-keys";

  describe("meCacheKey", () => {
    it("builds users:me:v1:{cognito_sub}:{user_id}", () => {
      expect(meCacheKey("sub-abc", "usr_1")).toBe("users:me:v1:sub-abc:usr_1");
    });

    // Cross-user isolation starts HERE, at the key. Two callers must never
    // produce the same key, and this is the cheapest place to prove it.
    it("produces a different key per user", () => {
      expect(meCacheKey("sub-a", "usr_a")).not.toBe(meCacheKey("sub-b", "usr_b"));
      // Same sub, different resolved user (a re-provisioned account) is also a
      // different key: BOTH components are part of the identity.
      expect(meCacheKey("sub-a", "usr_a")).not.toBe(meCacheKey("sub-a", "usr_b"));
    });

    // The prefix is the ONLY form that may appear in a CloudWatch dimension or a
    // span attribute — the full key embeds cognito_sub and user_id.
    it("exposes a prefix carrying no identity", () => {
      expect(ME_KEY_PREFIX).toBe("users:me:v1");
      expect(meCacheKey("sub-abc", "usr_1").startsWith(`${ME_KEY_PREFIX}:`)).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run the key test and confirm it fails for the right reason.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users test -- tests/shared/cache/cache-keys.test.ts`
  Expected: the suite fails at *collection* with `Failed to resolve import "#shared/cache/cache-keys"`
  (the module does not exist yet). Not an assertion failure — a resolution failure.

- [ ] **Step 3: Implement the key builder.**
  Create `services/users/src/shared/cache/cache-keys.ts`. Note the import convention: files inside
  `src/shared/**` import siblings with a relative `./x.ts` path including the extension, while
  `src/features/**` uses the `#shared/...` / `#features/...` subpath aliases without one
  (aliases declared at `services/users/package.json:9-18`, mirrored in `vitest.config.ts:5-10`).
  This file imports nothing, so the convention only matters for its consumers.

  ```ts
  // Key namespace for the response cache, sibling to reset-code-store.ts's
  // `password-reset:` prefix. Everything this service puts in Redis says what it
  // is up front, so a shared instance stays legible.
  //
  // `v1` is a MASS-INVALIDATION LEVER, not decoration: the cached value is the
  // serialized `UserSchema` body, so any change to that DTO's shape makes every
  // live entry wrong. Bumping to `v2` orphans the whole generation at once
  // (they expire on their own TTL) instead of requiring a flush.
  export const ME_KEY_PREFIX = "users:me:v1";

  // BOTH identity components, per [[x-cache-response-header]]. `cognito_sub`
  // alone is what the caller presents; `user_id` is what the row actually is.
  // Keying on both means a re-provisioned account (same sub, new usr_ id) cannot
  // read the previous account's cached profile.
  export function meCacheKey(cognitoSub: string, userId: string): string {
    return `${ME_KEY_PREFIX}:${cognitoSub}:${userId}`;
  }
  ```

- [ ] **Step 4: Run the key test and confirm it passes.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users test -- tests/shared/cache/cache-keys.test.ts`
  Expected: `Test Files 1 passed`, `Tests 3 passed`.

- [ ] **Step 5: Commit the key builder.**
  `git add services/users/src/shared/cache/cache-keys.ts services/users/tests/shared/cache/cache-keys.test.ts && git commit -m "feat(users): add the response-cache key builder for GET /v1/users/me"`
  (Per the repo's git rule, do not push — leave the commit in the branch for the batch review.)

- [ ] **Step 6: Write the failing `CacheGateway` test.**
  Create `services/users/tests/shared/cache/cache-gateway.test.ts`. The fake is real-shaped, not a
  blanket mock — same stance as `tests/shared/cache/reset-code-store.test.ts:9-12`, because the
  `EX`-form arguments and the `pttl` call are exactly what a blanket mock lets silently regress.
  No live Redis is contacted (`vitest.config.ts:32-38` declares `REDIS_HOST`/`REDIS_PORT` purely to
  satisfy the env schema).

  ```ts
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { CacheGateway } from "#shared/cache/cache-gateway";
  import { ME_KEY_PREFIX } from "#shared/cache/cache-keys";

  function fakeRedis() {
    const data = new Map<string, string>();
    const ttls = new Map<string, number>();
    return {
      data,
      ttls,
      get: vi.fn(async (key: string) => data.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, _mode: string, ttl: number) => {
        data.set(key, value);
        ttls.set(key, ttl * 1000);
        return "OK";
      }),
      // ioredis returns -2 for "no such key" and -1 for "no expiry".
      pttl: vi.fn(async (key: string) => ttls.get(key) ?? -2),
      del: vi.fn(async (...keys: string[]) => {
        let n = 0;
        for (const k of keys) if (data.delete(k)) n++;
        return n;
      }),
    };
  }

  function makeGateway(overrides: { redis?: unknown; cacheEnabled?: boolean } = {}) {
    const publish = vi.fn(async () => {});
    const redis = overrides.redis ?? fakeRedis();
    const gateway = new CacheGateway({
      redis: redis as never,
      metricsPublisher: { publish } as never,
      env: { CACHE_ENABLED: overrides.cacheEnabled ?? true } as never,
    });
    return { gateway, redis: redis as ReturnType<typeof fakeRedis>, publish };
  }

  let clock: { gateway: CacheGateway; redis: ReturnType<typeof fakeRedis>; publish: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    clock = makeGateway();
  });

  describe("CacheGateway.get", () => {
    it("reports a miss for an absent key", async () => {
      const res = await clock.gateway.get("users:me:v1:s:u", ME_KEY_PREFIX);

      expect(res).toEqual({ hit: false, value: undefined, ttlRemaining: undefined, bypass: false });
    });

    it("round-trips a value and reports the remaining TTL in whole seconds", async () => {
      await clock.gateway.set("users:me:v1:s:u", ME_KEY_PREFIX, { id: "usr_1" }, 300);
      const res = await clock.gateway.get<{ id: string }>("users:me:v1:s:u", ME_KEY_PREFIX);

      expect(res.hit).toBe(true);
      expect(res.value).toEqual({ id: "usr_1" });
      expect(res.ttlRemaining).toBe(300);
      expect(res.bypass).toBe(false);
    });

    it("sets the value and its expiry in ONE command (the EX form)", async () => {
      await clock.gateway.set("users:me:v1:s:u", ME_KEY_PREFIX, { id: "usr_1" }, 300);

      expect(clock.redis.set).toHaveBeenCalledWith(
        "users:me:v1:s:u",
        JSON.stringify({ id: "usr_1" }),
        "EX",
        300,
      );
    });

    // FAIL OPEN. The governing rule of this design: the cache may never break or
    // degrade a read.
    it("reports BYPASS, never throws, when Redis errors", async () => {
      const broken = { ...fakeRedis(), get: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) };
      const { gateway } = makeGateway({ redis: broken });

      const res = await gateway.get("users:me:v1:s:u", ME_KEY_PREFIX);

      expect(res).toEqual({ hit: false, value: undefined, ttlRemaining: undefined, bypass: true });
    });

    it("reports BYPASS when Redis exceeds the 50ms budget", async () => {
      const slow = {
        ...fakeRedis(),
        get: vi.fn(() => new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 500))),
      };
      const { gateway } = makeGateway({ redis: slow });

      const started = Date.now();
      const res = await gateway.get("users:me:v1:s:u", ME_KEY_PREFIX);

      expect(res.bypass).toBe(true);
      // The point of the timeout is that the caller is NOT made to wait 500ms.
      expect(Date.now() - started).toBeLessThan(400);
    });

    it("swallows a set() failure entirely — a cache-write error never surfaces", async () => {
      const broken = { ...fakeRedis(), set: vi.fn(async () => { throw new Error("OOM"); }) };
      const { gateway } = makeGateway({ redis: broken });

      await expect(gateway.set("users:me:v1:s:u", ME_KEY_PREFIX, { id: "usr_1" }, 300))
        .resolves.toBeUndefined();
    });

    it("swallows an invalidate() failure — the write it follows already persisted", async () => {
      const broken = { ...fakeRedis(), del: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) };
      const { gateway } = makeGateway({ redis: broken });

      await expect(gateway.invalidate(ME_KEY_PREFIX, "users:me:v1:s:u")).resolves.toBeUndefined();
    });
  });

  describe("CacheGateway metrics", () => {
    it("publishes cache_requests_total with the PREFIX only, never the full key", async () => {
      await clock.gateway.get("users:me:v1:sub-secret:usr_secret", ME_KEY_PREFIX);

      expect(clock.publish).toHaveBeenCalledWith("cache_requests_total", 1, {
        Service: "users",
        KeyPrefix: "users:me:v1",
        Result: "miss",
      });
      // The load-bearing assertion: a CloudWatch dimension value carrying a
      // cognito_sub would both explode cardinality and export PII.
      const dimensionValues = clock.publish.mock.calls.flatMap((c) => Object.values(c[2] as object));
      expect(dimensionValues.some((v) => String(v).includes("sub-secret"))).toBe(false);
      expect(dimensionValues.some((v) => String(v).includes("usr_secret"))).toBe(false);
    });

    it("publishes cache_operation_duration_ms in Milliseconds per operation", async () => {
      await clock.gateway.get("users:me:v1:s:u", ME_KEY_PREFIX);

      const call = clock.publish.mock.calls.find((c) => c[0] === "cache_operation_duration_ms");
      expect(call).toBeDefined();
      expect(call![2]).toEqual({ Service: "users", Operation: "get" });
      expect(call![3]).toBe("Milliseconds");
    });

    it("labels a Redis failure Result=bypass, not miss", async () => {
      const broken = { ...fakeRedis(), get: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) };
      const { gateway, publish } = makeGateway({ redis: broken });

      await gateway.get("users:me:v1:s:u", ME_KEY_PREFIX);

      expect(publish).toHaveBeenCalledWith("cache_requests_total", 1, {
        Service: "users",
        KeyPrefix: "users:me:v1",
        Result: "bypass",
      });
    });
  });

  describe("CacheGateway kill switch", () => {
    it("touches Redis for nothing when CACHE_ENABLED is false", async () => {
      const { gateway, redis } = makeGateway({ cacheEnabled: false });

      expect(gateway.enabled).toBe(false);
      await gateway.get("users:me:v1:s:u", ME_KEY_PREFIX);
      await gateway.set("users:me:v1:s:u", ME_KEY_PREFIX, { id: "usr_1" }, 300);
      await gateway.invalidate(ME_KEY_PREFIX, "users:me:v1:s:u");

      expect(redis.get).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 7: Run the gateway test and confirm it fails for the right reason.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users test -- tests/shared/cache/cache-gateway.test.ts`
  Expected: collection failure, `Failed to resolve import "#shared/cache/cache-gateway"`.

- [ ] **Step 8: Implement `CacheGateway`.**
  Create `services/users/src/shared/cache/cache-gateway.ts`. Relative `./x.ts` imports, per the
  `src/shared/**` convention.

  ```ts
  import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
  import type { RedisClient } from "./redis.ts";
  import type { Env } from "../config/env.ts";
  import type { MetricsPublisher } from "../metrics/cloudwatch-metrics.ts";
  import { appLogger } from "../logging/app-logger.ts";

  // Per-operation budget. The cache exists to make a read faster; an operation
  // that outruns this has already failed at its only job, so we stop waiting and
  // answer from Postgres. 50ms is the figure in the design spec.
  const TIMEOUT_MS = 50;

  const tracer = trace.getTracer("users-cache");

  export interface CacheGetResult<T> {
    hit: boolean;
    value: T | undefined;
    ttlRemaining: number | undefined;
    // Distinct from `hit: false`. A MISS means Redis answered "not here"; a
    // BYPASS means Redis did not answer at all. They are different operational
    // facts and the metrics keep them apart — bypass is excluded from the
    // hit-rate denominator, so a Redis outage cannot masquerade as a poor
    // hit-rate.
    bypass: boolean;
  }

  // Transport layer for the response cache: JSON serialization, the timeout, and
  // the metric/span/log emission. It knows nothing about HTTP — the hooks own
  // that. Holds NO connection of its own: `redis` is the existing SINGLETON
  // ioredis client (see redis.ts and the container registration), whose mandatory
  // `error` listener is what keeps a reconnect blip from crashing the process.
  export class CacheGateway {
    private readonly redis: RedisClient;
    private readonly metrics: MetricsPublisher;
    readonly enabled: boolean;

    constructor({
      redis,
      metricsPublisher,
      env,
    }: {
      redis: RedisClient;
      metricsPublisher: MetricsPublisher;
      env: Env;
    }) {
      this.redis = redis;
      this.metrics = metricsPublisher;
      this.enabled = env.CACHE_ENABLED;
    }

    async get<T>(key: string, keyPrefix: string): Promise<CacheGetResult<T>> {
      if (!this.enabled) {
        return { hit: false, value: undefined, ttlRemaining: undefined, bypass: false };
      }

      const started = Date.now();
      try {
        // Value and remaining TTL in one round trip. A pipeline, not two awaits:
        // two sequential awaits would pay the RTT twice and could read a PTTL
        // for a key that expired between them.
        const [rawValue, rawPttl] = await this.withTimeout(
          this.redis
            .pipeline()
            .get(key)
            .pttl(key)
            .exec()
            .then((replies) => [
              replies?.[0]?.[1] as string | null,
              replies?.[1]?.[1] as number,
            ] as const),
          "get",
        );

        const durationMs = Date.now() - started;

        if (rawValue === null || rawValue === undefined) {
          this.report("miss", keyPrefix, "get", durationMs, undefined);
          return { hit: false, value: undefined, ttlRemaining: undefined, bypass: false };
        }

        // ioredis PTTL: -2 = no such key, -1 = key with no expiry. Neither is a
        // sane "seconds remaining", so both collapse to undefined and the HIT
        // simply ships without an X-Cache-TTL header rather than with a lie.
        const ttlRemaining = rawPttl > 0 ? Math.ceil(rawPttl / 1000) : undefined;
        this.report("hit", keyPrefix, "get", durationMs, ttlRemaining);
        return { hit: true, value: JSON.parse(rawValue) as T, ttlRemaining, bypass: false };
      } catch (err) {
        // FAIL OPEN. Includes a JSON.parse failure on a corrupt entry: a body we
        // cannot deserialize is indistinguishable, for the caller, from Redis
        // being down — both mean "answer from Postgres".
        this.reportUnavailable(err, keyPrefix, "get", Date.now() - started);
        return { hit: false, value: undefined, ttlRemaining: undefined, bypass: true };
      }
    }

    async set(key: string, keyPrefix: string, value: unknown, ttlSeconds: number): Promise<void> {
      if (!this.enabled) return;

      const started = Date.now();
      try {
        // `EX` (not a follow-up PEXPIRE) so the value and its lifetime are set in
        // ONE command — same argument as reset-code-store.ts: a crash between a
        // SET and a separate expire leaves a never-expiring entry behind.
        await this.withTimeout(this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds), "set");
        this.reportDuration("set", Date.now() - started);
      } catch (err) {
        // A cache-write failure never affects the response. The caller has
        // already produced a correct body; this is bookkeeping.
        this.reportUnavailable(err, keyPrefix, "set", Date.now() - started);
      }
    }

    async invalidate(keyPrefix: string, ...keys: string[]): Promise<void> {
      if (!this.enabled || keys.length === 0) return;

      try {
        // Variadic DEL, one round trip regardless of key count.
        await this.withTimeout(this.redis.del(...keys), "del");
      } catch (err) {
        // Swallowed, and this is the one swallow that deserves its own note.
        // Invalidation runs AFTER the write has persisted, so a failure here
        // leaves a stale entry that the 5-minute TTL still clears. Throwing
        // would turn a successful profile update into a 500 for the user, which
        // is strictly worse than five minutes of staleness.
        this.reportUnavailable(err, keyPrefix, "del", 0);
      }
    }

    // Rejects with a named error rather than hanging on ioredis' own retry
    // schedule. `maxRetriesPerRequest: 2` (redis.ts:29) already bounds a command
    // during an outage, but not one against a Redis that is UP and merely slow —
    // which is the case this budget exists for.
    private withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
      let timer: NodeJS.Timeout;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`cache ${label} exceeded ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS,
        );
        // unref() so a pending timer never holds the process open at shutdown —
        // same reasoning as BusinessMetricsPoller's interval.
        timer.unref();
      });
      return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
    }

    // ==== ONLY THE PREFIX EVER LEAVES THIS CLASS ====
    // `keyPrefix` is "users:me:v1"; the full key carries cognito_sub and user_id.
    // A CloudWatch dimension value is unbounded-cardinality billing AND an export
    // destination, and so is a span attribute. Neither may ever receive the key.
    private report(
      result: "hit" | "miss" | "bypass",
      keyPrefix: string,
      operation: "get" | "set" | "del",
      durationMs: number,
      ttlRemaining: number | undefined,
    ): void {
      const span = trace.getActiveSpan();
      span?.setAttributes({
        "cache.result": result,
        "cache.key_prefix": keyPrefix,
        ...(ttlRemaining !== undefined ? { "cache.ttl_remaining": ttlRemaining } : {}),
      });

      // Deliberately NOT awaited and never rethrown: `publish` swallows its own
      // failures by contract (cloudwatch-metrics.ts) so there is no unhandled
      // rejection, and awaiting a PutMetricData round trip inside a cached read
      // would hand back the latency the cache just saved.
      void this.metrics.publish("cache_requests_total", 1, {
        Service: "users",
        KeyPrefix: keyPrefix,
        Result: result,
      });
      this.reportDuration(operation, durationMs);
    }

    private reportDuration(operation: "get" | "set" | "del", durationMs: number): void {
      void this.metrics.publish(
        "cache_operation_duration_ms",
        durationMs,
        { Service: "users", Operation: operation },
        "Milliseconds",
      );
    }

    private reportUnavailable(
      err: unknown,
      keyPrefix: string,
      operation: "get" | "set" | "del",
      durationMs: number,
    ): void {
      // WARN, not ERROR: nothing is broken for the user — the read fell through
      // to Postgres and answered correctly. `reason` is machine-readable so an
      // operator can separate a timeout from a connection failure without
      // parsing the message ([[logging-context]]).
      appLogger.warn(
        {
          err,
          app_event: "cache_unavailable",
          reason: err instanceof Error && err.message.includes("exceeded")
            ? "timeout"
            : "redis_error",
          cache_operation: operation,
          // The PREFIX, for the same reason it is the only thing on the span.
          cache_key_prefix: keyPrefix,
        },
        "Cache unavailable; falling through to the database",
      );
      this.report("bypass", keyPrefix, operation, durationMs, undefined);
    }

    // A child span per operation, per the design's Observability item 2. Public
    // so the HTTP hooks can wrap the get/set inside the request's own span —
    // see cache-hooks.ts, where WHICH span is active is load-bearing.
    static async withCacheSpan<T>(name: "cache.get" | "cache.set", fn: () => Promise<T>): Promise<T> {
      return tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL }, async (span) => {
        try {
          const result = await fn();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } finally {
          // In a `finally`, like withWorkflowSpan: a span left open on the
          // exception path never reaches OpenObserve and does not surface as an
          // error anywhere — it simply vanishes.
          span.end();
        }
      });
    }
  }
  ```

- [ ] **Step 9: Run the gateway test and confirm it passes.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users test -- tests/shared/cache/cache-gateway.test.ts`
  Expected: `Test Files 1 passed`, `Tests 12 passed`.

- [ ] **Step 10: Commit the gateway.**
  `git add services/users/src/shared/cache/cache-gateway.ts services/users/tests/shared/cache/cache-gateway.test.ts && git commit -m "feat(users): add CacheGateway with a 50ms fail-open budget and prefix-only telemetry"`

- [ ] **Step 11: Write the failing DI-registration test.**
  Create `services/users/tests/shared/di/cache-registrations.test.ts`, modelled on
  `tests/shared/di/metrics-registrations.test.ts` — which exists because a wiring mistake
  (`asClass` on a constructor whose destructured parameter is not a cradle key) is a
  *resolution-time* failure that typecheck, lint and every unit test pass straight through, while
  the service dies on boot and the gateway answers 502. `CacheGateway`'s constructor takes
  `{ redis, metricsPublisher, env }` — all three ARE cradle keys — but the test proves it rather
  than trusting it.

  ```ts
  import { describe, it, expect, beforeAll } from "vitest";
  import { diContainer } from "@fastify/awilix";
  import { registerSingletons } from "#shared/di/awilix-container";
  import { CacheGateway } from "#shared/cache/cache-gateway";

  describe("cache DI registrations", () => {
    beforeAll(() => {
      registerSingletons();
    });

    it("resolves cacheGateway, walking the redis + metricsPublisher chain", () => {
      expect(diContainer.resolve("cacheGateway")).toBeInstanceOf(CacheGateway);
    });

    it("returns the same instance twice — SINGLETON, sharing the one ioredis socket", () => {
      // Not a style assertion. A per-request gateway would be harmless on its own
      // (it holds no connection), but the registration must resolve the SINGLETON
      // `redis` rather than ever constructing a second client.
      expect(diContainer.resolve("cacheGateway")).toBe(diContainer.resolve("cacheGateway"));
      expect(diContainer.resolve("redis")).toBe(diContainer.resolve("redis"));
    });
  });
  ```

- [ ] **Step 12: Run the DI test and confirm it fails for the right reason.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users test -- tests/shared/di/cache-registrations.test.ts`
  Expected: `AwilixResolutionError: Could not resolve 'cacheGateway'` — the name is not registered
  yet. (A TypeScript error on `resolve("cacheGateway")` is also expected until Step 13 augments the
  `Cradle` interface; vitest runs through esbuild and does not typecheck, so the runtime error is
  what you will see.)

- [ ] **Step 13: Register `cacheGateway` in the container.**
  In `services/users/src/shared/di/awilix-container.ts`:

  1. Add the import beside the existing cache imports (`:15-16`):
     ```ts
     import { CacheGateway } from "../cache/cache-gateway.ts";
     ```
  2. Add the cradle member inside `declare module "@fastify/awilix"` -> `interface Cradle`,
     directly after `resetCodeStore` (`:46`):
     ```ts
     cacheGateway: CacheGateway;
     ```
  3. Register it in `registerSingletons()`, immediately after the `resetCodeStore` line (`:149`):
     ```ts
     // Stateless over the SINGLETON `redis` client — SINGLETON alongside it, the
     // same reasoning as resetCodeStore. It opens no connection of its own; a
     // second ioredis client would mean a second TCP socket and a second
     // reconnect state machine for no gain.
     //
     // asClass is correct here (unlike metricsPublisher above): every name this
     // constructor destructures — redis, metricsPublisher, env — IS a registered
     // cradle key, so PROXY injection resolves all three. The DI test proves it.
     cacheGateway: asClass(CacheGateway, { lifetime: Lifetime.SINGLETON }),
     ```

- [ ] **Step 14: Run the DI test and confirm it passes.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users test -- tests/shared/di/cache-registrations.test.ts`
  Expected: `Test Files 1 passed`, `Tests 2 passed`.

- [ ] **Step 15: Add `cache_result` to the shared log context.**
  In `services/users/src/shared/logging/log-context.ts`, inside `interface LogContextStore`
  (`:12-34`), after `order_id?: string;` (`:33`):

  ```ts
    /**
     * Cache outcome for this request: "hit" | "miss" | "bypass". Set by the
     * response-cache hooks (see features/users/http/cache-hooks.ts) on cacheable
     * routes only. OMITTED — never null — on every other route: an absent key
     * reads as "this route is not cached", whereas a null reads as "it is cached
     * and somehow produced no outcome".
     */
    cache_result?: "hit" | "miss" | "bypass";
  ```

  No test of its own — it is a type-only widening with no runtime behaviour, and the hook tests in
  Step 17 assert the field actually lands on the log line.

- [ ] **Step 16: Commit the wiring.**
  `git add services/users/src/shared/di/awilix-container.ts services/users/src/shared/logging/log-context.ts services/users/tests/shared/di/cache-registrations.test.ts && git commit -m "feat(users): register cacheGateway and add cache_result to the log context"`

- [ ] **Step 17: Write the failing hook test — the eight required cases.**
  Create `services/users/tests/features/users/http/cache-hooks.test.ts`. It reuses the container
  shape from `tests/features/users/http/routes.test.ts:57-99` — note in particular that **every**
  test container needs a `db` stub, because `routes.ts`'s `onRequest` hook registers `currentUser`
  on every request regardless of route (the comment at `routes.test.ts:60-64` says exactly this).

  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { createContainer, asValue, asFunction, Lifetime } from "awilix";
  import { buildApp } from "#features/users/http/routes";
  import { UserQueryService } from "#features/users/queries/get-me";
  import { CacheGateway } from "#shared/cache/cache-gateway";
  import { meCacheKey } from "#shared/cache/cache-keys";

  const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");

  function fakeUser(overrides: Record<string, unknown> = {}) {
    return {
      id: "usr_1",
      email: "a@b.co",
      fullName: "A",
      address: null,
      phoneNumber: null,
      tags: [] as string[],
      authType: "PASSWORD" as const,
      mustChangePassword: false,
      createdBy: "usr_1",
      createdAt: FIXED_DATE,
      updatedBy: "usr_1",
      updatedAt: FIXED_DATE,
      deletedBy: null,
      deletedAt: null,
      isDeleted: false,
      ...overrides,
    };
  }

  // Real-shaped, Map-backed, per tests/shared/cache/reset-code-store.test.ts:9-12.
  function fakeRedis() {
    const data = new Map<string, string>();
    const ttls = new Map<string, number>();
    return {
      data,
      get: vi.fn(async (key: string) => data.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, _mode: string, ttl: number) => {
        data.set(key, value);
        ttls.set(key, ttl * 1000);
        return "OK";
      }),
      pttl: vi.fn(async (key: string) => ttls.get(key) ?? -2),
      del: vi.fn(async (...keys: string[]) => {
        let n = 0;
        for (const k of keys) if (data.delete(k)) n++;
        return n;
      }),
      pipeline: vi.fn(function (this: unknown) {
        const ops: Array<() => Promise<unknown>> = [];
        const chain = {
          get(key: string) { ops.push(async () => data.get(key) ?? null); return chain; },
          pttl(key: string) { ops.push(async () => ttls.get(key) ?? -2); return chain; },
          async exec() {
            const out: Array<[null, unknown]> = [];
            for (const op of ops) out.push([null, await op()]);
            return out;
          },
        };
        return chain;
      }),
    };
  }

  // A user identified by their Cognito sub, resolving through the REAL
  // UserQueryService over a stubbed db — a mocked getMe would skip
  // CurrentUser.resolve(), which is the only place user_id becomes known and
  // therefore the only place the cache key can be completed.
  function cacheContainer(opts: {
    redis?: unknown;
    cacheEnabled?: boolean;
    row?: Record<string, unknown> | null;
  } = {}) {
    const redis = opts.redis ?? fakeRedis();
    const row = opts.row === undefined ? fakeUser({ cognitoSub: "sub-a" }) : opts.row;
    const findByIdOrCognitoSub = vi.fn(async () => row);
    const update = vi.fn(async () => row);
    const container = createContainer({ injectionMode: "PROXY" });
    container.register({
      db: asValue({ user: { findByIdOrCognitoSub, update } } as any),
      env: asValue({ E2E_TESTING_ENABLED: false, CACHE_ENABLED: opts.cacheEnabled ?? true } as any),
      metricsPublisher: asValue({ publish: vi.fn(async () => {}) } as any),
      redis: asValue(redis as any),
      cacheGateway: asFunction((cradle: any) => new CacheGateway(cradle), {
        lifetime: Lifetime.SINGLETON,
      }),
      userQueryService: asFunction((cradle: any) => new UserQueryService(cradle), {
        lifetime: Lifetime.SCOPED,
      }),
      updateProfileCommand: asValue({
        execute: vi.fn(async () => fakeUser({ fullName: "Renamed", cognitoSub: "sub-a" })),
      } as any),
      changePasswordCommand: asValue({
        execute: vi.fn(async () => fakeUser({ mustChangePassword: false, cognitoSub: "sub-a" })),
      } as any),
      // Present because routes.ts resolves them at registration time.
      registerUserCommand: asValue({ execute: vi.fn() } as any),
      registerPasswordlessCommand: asValue({ execute: vi.fn() } as any),
      loginUserCommand: asValue({ execute: vi.fn() } as any),
      startOtpChallengeCommand: asValue({ execute: vi.fn() } as any),
      verifyOtpChallengeCommand: asValue({ execute: vi.fn() } as any),
      refreshTokenCommand: asValue({ execute: vi.fn() } as any),
      forgotPasswordCommand: asValue({ execute: vi.fn(async () => undefined) } as any),
      confirmPasswordResetCommand: asValue({ execute: vi.fn(async () => undefined) } as any),
      captureCognitoIdentityCommand: asValue({ execute: vi.fn() } as any),
    });
    return { container, redis: redis as ReturnType<typeof fakeRedis>, findByIdOrCognitoSub };
  }

  const AS_A = { "x-user-id": "sub-a" };

  describe("GET /v1/users/me response cache", () => {
    // (1) MISS then HIT, with X-Cache-TTL on the HIT only.
    it("answers MISS then HIT, and carries X-Cache-TTL on the HIT alone", async () => {
      const { container } = cacheContainer();
      const app = buildApp(container);

      const first = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
      expect(first.statusCode).toBe(200);
      expect(first.headers["x-cache"]).toBe("MISS");
      expect(first.headers["x-cache-ttl"]).toBeUndefined();

      const second = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
      expect(second.statusCode).toBe(200);
      expect(second.headers["x-cache"]).toBe("HIT");
      // 5-minute TTL, in whole seconds remaining.
      expect(Number(second.headers["x-cache-ttl"])).toBeGreaterThan(0);
      expect(Number(second.headers["x-cache-ttl"])).toBeLessThanOrEqual(300);

      await app.close();
    });

    // (2) The HIT body is BYTE-IDENTICAL to the MISS body. This is the test that
    // catches a cached ENTITY (Date objects) instead of a cached SERIALIZED body
    // (ISO strings) — a bug that makes a HIT and a MISS return different JSON for
    // the same user, which no status-code assertion would ever notice.
    it("returns a byte-identical body on the HIT", async () => {
      const { container } = cacheContainer();
      const app = buildApp(container);

      const miss = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
      const hit = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });

      expect(hit.body).toBe(miss.body);
      expect(hit.json()).toEqual({
        ...fakeUser(),
        createdAt: FIXED_DATE.toISOString(),
        updatedAt: FIXED_DATE.toISOString(),
        deletedAt: null,
      });

      await app.close();
    });

    // (3) PATCH /v1/users/me invalidates.
    it("goes back to MISS after PATCH /v1/users/me", async () => {
      const { container } = cacheContainer();
      const app = buildApp(container);

      await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
      expect((await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A }))
        .headers["x-cache"]).toBe("HIT");

      const patched = await app.inject({
        method: "PATCH",
        url: "/v1/users/me",
        headers: AS_A,
        payload: { fullName: "Renamed" },
      });
      expect(patched.statusCode).toBe(200);
      // The write itself is never cached and carries no X-Cache header.
      expect(patched.headers["x-cache"]).toBeUndefined();

      expect((await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A }))
        .headers["x-cache"]).toBe("MISS");

      await app.close();
    });

    // (4) A password change invalidates, because `mustChangePassword` is a field
    // of UserSchema and therefore part of the cached body. Easy to miss: nothing
    // about "change password" reads as "profile write".
    it("goes back to MISS after PATCH /v1/users/me/password", async () => {
      const { container } = cacheContainer({ row: fakeUser({ cognitoSub: "sub-a", mustChangePassword: true }) });
      const app = buildApp(container);

      await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
      expect((await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A }))
        .headers["x-cache"]).toBe("HIT");

      const changed = await app.inject({
        method: "PATCH",
        url: "/v1/users/me/password",
        headers: AS_A,
        payload: { newPassword: "Sup3rSecret!" },
      });
      expect(changed.statusCode).toBe(200);

      expect((await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A }))
        .headers["x-cache"]).toBe("MISS");

      await app.close();
    });

    // (5) CROSS-USER ISOLATION. Non-negotiable: the single worst failure this
    // cache could produce is one user reading another's profile.
    it("never serves user A's cached profile to user B", async () => {
      const rowA = fakeUser({ id: "usr_a", email: "a@b.co", cognitoSub: "sub-a" });
      const rowB = fakeUser({ id: "usr_b", email: "b@b.co", cognitoSub: "sub-b" });
      const redis = fakeRedis();
      const findByIdOrCognitoSub = vi.fn(async (identity: string) =>
        identity === "sub-a" ? rowA : rowB,
      );
      const { container } = cacheContainer({ redis });
      container.register({
        db: asValue({ user: { findByIdOrCognitoSub, update: vi.fn() } } as any),
      });
      const app = buildApp(container);

      const a1 = await app.inject({ method: "GET", url: "/v1/users/me", headers: { "x-user-id": "sub-a" } });
      expect(a1.headers["x-cache"]).toBe("MISS");
      expect(a1.json().id).toBe("usr_a");

      // B's FIRST request must be a MISS — a HIT here would mean B matched A's
      // entry, which is the bug.
      const b1 = await app.inject({ method: "GET", url: "/v1/users/me", headers: { "x-user-id": "sub-b" } });
      expect(b1.headers["x-cache"]).toBe("MISS");
      expect(b1.json().id).toBe("usr_b");
      expect(b1.json().email).toBe("b@b.co");

      // And each keeps its own entry afterwards.
      const a2 = await app.inject({ method: "GET", url: "/v1/users/me", headers: { "x-user-id": "sub-a" } });
      expect(a2.headers["x-cache"]).toBe("HIT");
      expect(a2.json().id).toBe("usr_a");
      const b2 = await app.inject({ method: "GET", url: "/v1/users/me", headers: { "x-user-id": "sub-b" } });
      expect(b2.headers["x-cache"]).toBe("HIT");
      expect(b2.json().id).toBe("usr_b");

      // Two distinct keys in the store, and neither is the other's.
      expect(redis.data.has(meCacheKey("sub-a", "usr_a"))).toBe(true);
      expect(redis.data.has(meCacheKey("sub-b", "usr_b"))).toBe(true);

      await app.close();
    });

    // (6) FAIL OPEN.
    it("answers BYPASS with a correct body when Redis throws", async () => {
      const broken = {
        ...fakeRedis(),
        pipeline: vi.fn(() => ({
          get() { return this; },
          pttl() { return this; },
          exec: async () => { throw new Error("ECONNREFUSED"); },
        })),
        set: vi.fn(async () => { throw new Error("ECONNREFUSED"); }),
      };
      const { container } = cacheContainer({ redis: broken });
      const app = buildApp(container);

      const res = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });

      expect(res.statusCode).toBe(200);
      expect(res.headers["x-cache"]).toBe("BYPASS");
      expect(res.headers["x-cache-ttl"]).toBeUndefined();
      expect(res.json().id).toBe("usr_1");

      await app.close();
    });

    // (7) A 404 is never cached: only 200s populate the store.
    it("does not cache a 404, so a later-created user is not shadowed", async () => {
      const { container, redis } = cacheContainer({ row: null });
      const app = buildApp(container);

      const res = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
      // Nothing was written — and note there is no key to write it under anyway:
      // an unresolved caller has no user_id.
      expect(redis.set).not.toHaveBeenCalled();

      await app.close();
    });

    // (8) The kill switch. Not "X-Cache: BYPASS" — NO header at all.
    it("emits no X-Cache header whatsoever when CACHE_ENABLED is false", async () => {
      const { container, redis } = cacheContainer({ cacheEnabled: false });
      const app = buildApp(container);

      const first = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
      const second = await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });

      expect(first.statusCode).toBe(200);
      expect(first.headers["x-cache"]).toBeUndefined();
      expect(second.headers["x-cache"]).toBeUndefined();
      expect(second.json().id).toBe("usr_1");
      expect(redis.get).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();

      await app.close();
    });

    it("stamps cache_result on the request's log line", async () => {
      const lines: string[] = [];
      const { container } = cacheContainer();
      const app = buildApp(container, { logStream: { write: (s: string) => lines.push(s) } });

      await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });
      await app.inject({ method: "GET", url: "/v1/users/me", headers: AS_A });

      const requestLogs = lines
        .map((l) => JSON.parse(l))
        .filter((e) => e.http_route === "/v1/users/me");
      expect(requestLogs.map((e) => e.cache_result)).toEqual(["miss", "hit"]);

      await app.close();
    });

    it("omits cache_result on a non-cacheable route", async () => {
      const lines: string[] = [];
      const { container } = cacheContainer();
      const app = buildApp(container, { logStream: { write: (s: string) => lines.push(s) } });

      await app.inject({
        method: "PATCH",
        url: "/v1/users/me",
        headers: AS_A,
        payload: { fullName: "Renamed" },
      });

      const patchLog = lines
        .map((l) => JSON.parse(l))
        .find((e) => e.http_route === "/v1/users/me" && e.http_request_method === "PATCH");
      expect(patchLog).toBeDefined();
      // OMITTED, not null — an absent key reads as "this route is not cached".
      expect("cache_result" in patchLog!).toBe(false);

      await app.close();
    });
  });
  ```

- [ ] **Step 18: Run the hook test and confirm it fails for the right reason.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users test -- tests/features/users/http/cache-hooks.test.ts`
  Expected: collection failure, `Failed to resolve import "#shared/cache/cache-gateway"` is already
  satisfied, so instead the first test fails on
  `expected undefined to be 'MISS'` — no hook exists yet, so no `X-Cache` header is emitted.

- [ ] **Step 19: Implement the `preHandler`/`onSend` hook pair.**
  Create `services/users/src/features/users/http/cache-hooks.ts`. `src/features/**` uses the
  `#shared/...` alias form without an extension.

  **Two traps live in this file. Read both before writing it.**

  *Trap 1 — the key cannot be built in `onRequest`.* The `onRequest` hook
  (`routes.ts:290-329`) knows only `req.headers["x-user-id"]`, which is *either* a `usr_` id *or*
  a Cognito sub — `CurrentUser.identity`'s own doc comment says so
  (`current-user.ts:4-5,9`). The key needs the resolved `user_id`, and the single choke point
  where that becomes known is `CurrentUser.resolve()` (`current-user.ts:18-22`), which calls
  `db.user.findByIdOrCognitoSub` and then `setLogContext({ user_id: row.id })`
  (`current-user.ts:39-46`). **Consequence: the `preHandler` must `await currentUser.resolve()`
  before it can build the key.** That is not wasted work — `UserQueryService.getMe` calls the same
  `resolve()` (`get-me.ts:34`), which caches its *promise*, so the handler on a MISS reuses this
  exact lookup rather than issuing a second query. On a HIT the handler never runs, and this one
  lookup is the only DB touch of the request. It also means an unresolvable caller (a valid token
  for a deleted account) has **no key at all** — it skips the cache entirely and falls through to
  the handler's 404, which is why test (7) asserts nothing was written.

  *Trap 2 — the span in `onSend`.* Users has no `preHandler` and no `onSend` hook today; its only
  two global hooks are `onRequest` (`routes.ts:290`) and `onResponse` (`routes.ts:134`), so this
  pair is the first of its kind in the service. `@fastify/otel` **nulls
  `request.opentelemetry().span` inside `onSend`**, and `onSend` runs *before* `onResponse` —
  documented at `services/users/src/shared/observability/request-span.ts:40`. Therefore
  `trace.getActiveSpan()` inside `onSend` resolves to the *hook's* span or `undefined`, never the
  request's HTTP SERVER span. Any span or log emitted from `onSend` must be wrapped in
  `withHttpServerSpan(request, fn)` (`request-span.ts:79`) — which resolves the server span via
  `getRPCMetadata` over `request.opentelemetry().context` rather than the nulled `.span`. Getting
  this wrong **does not error**: the span silently vanishes, which is a far harder failure to
  notice than a crash.

  ```ts
  import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
  import { CacheGateway } from "#shared/cache/cache-gateway";
  import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";
  import { setLogContext } from "#shared/logging/log-context";
  import { withHttpServerSpan } from "#shared/observability/request-span";

  /** 5 minutes — the profile changes rarely, and every write invalidates it. */
  export const ME_CACHE_TTL_SECONDS = 300;

  /** The route this pair guards. Only this one route is cached in Users. */
  export const ME_ROUTE = "/v1/users/me";

  // Per-request state, stashed on the request object so `onSend` can see what
  // `preHandler` decided. A WeakMap keyed by the request, NOT a decorator: a
  // decorator would put the key (which carries cognito_sub and user_id) on an
  // object other code can serialize, and this state must not outlive the request.
  interface CacheState {
    key: string;
    result: "hit" | "miss" | "bypass";
  }
  const stateFor = new WeakMap<FastifyRequest, CacheState>();

  // Only a GET on the cached route participates. The PATCHes registered on the
  // same URL must never see a hook, which is why method is checked too.
  function isCacheableRequest(req: FastifyRequest): boolean {
    return req.method === "GET" && (req.routeOptions?.url ?? req.url) === ME_ROUTE;
  }

  export function registerMeCacheHooks(app: FastifyInstance): void {
    app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
      const { cacheGateway, currentActor, currentUser } = req.diScope.cradle;
      if (!cacheGateway.enabled || !isCacheableRequest(req) || currentActor === undefined) return;

      // ==== THE KEY CANNOT EXIST BEFORE THIS AWAIT ====
      // `currentActor` is the raw x-user-id, which may be a Cognito sub OR a
      // usr_ id (see CurrentUser's doc comment). The key needs the RESOLVED
      // user_id, and resolve() is the only place it becomes known. resolve()
      // caches its promise, so the handler on a MISS reuses this same lookup —
      // this await costs one query per request, not two.
      const row = await currentUser.resolve();
      if (!row?.id) {
        // A valid token whose user no longer exists. There is no key to build,
        // so this request bypasses the cache silently and the handler answers
        // its 404 — which is never cached anyway.
        return;
      }

      const key = meCacheKey(currentActor, row.id);
      const outcome = await CacheGateway.withCacheSpan("cache.get", () =>
        cacheGateway.get<unknown>(key, ME_KEY_PREFIX),
      );

      const result = outcome.bypass ? "bypass" : outcome.hit ? "hit" : "miss";
      stateFor.set(req, { key, result });
      // Merged into the ACTIVE log-context store, so every later line of this
      // request — including `request completed`, emitted in onResponse by code
      // that knows nothing about caching — carries it.
      setLogContext({ cache_result: result });

      if (outcome.hit) {
        // Short-circuit: `reply.send` from a preHandler means the handler never
        // executes, which is the whole point of the interceptor.
        //
        // The cached value is the SERIALIZED body (see the onSend hook), so it
        // is sent as-is. `type("application/json")` + a pre-serialized payload
        // keeps Fastify's Zod response serializer out of the path — it would
        // otherwise re-validate an already-serialized object.
        reply
          .header("X-Cache", "HIT")
          // Omitted rather than sent as 0/-1 when Redis reported no usable TTL.
          .headers(
            outcome.ttlRemaining !== undefined
              ? { "X-Cache-TTL": String(outcome.ttlRemaining) }
              : {},
          )
          .type("application/json")
          .send(JSON.stringify(outcome.value));
      }
    });

    app.addHook("onSend", async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
      const state = stateFor.get(req);
      if (state === undefined) return payload;

      // A HIT already carries its headers from the preHandler; there is nothing
      // to store and nothing to stamp.
      if (state.result === "hit") return payload;

      reply.header("X-Cache", state.result === "bypass" ? "BYPASS" : "MISS");

      // ONLY 200s populate the cache. A 404/500 body cached for five minutes
      // would outlive its cause.
      if (state.result === "miss" && reply.statusCode === 200 && typeof payload === "string") {
        const { cacheGateway } = req.diScope.cradle;

        // ==== WHY withHttpServerSpan AND NOT trace.getActiveSpan() ====
        // @fastify/otel NULLS `request.opentelemetry().span` inside onSend,
        // which runs BEFORE onResponse (request-span.ts:40). So the active span
        // here is the hook's own span or nothing at all, and a `cache.set` span
        // parented to it silently vanishes from the waterfall — no error, no
        // warning, just a missing bar. withHttpServerSpan resolves the request's
        // real HTTP SERVER span through RPC metadata on the request's context,
        // which survives the nulling.
        //
        // NOT awaited: onSend sits on the response path, and holding the
        // response open for a Redis round trip would hand back the latency this
        // cache exists to remove. `set` swallows its own failures by contract,
        // so there is no unhandled rejection.
        void withHttpServerSpan(req, () =>
          CacheGateway.withCacheSpan("cache.set", () =>
            // `payload` is the ALREADY-SERIALIZED response body — the exact
            // bytes Fastify is about to write. Storing THIS, rather than the
            // domain entity, is what makes a HIT byte-identical to a MISS:
            // serializeUser converts createdAt/updatedAt/deletedAt to ISO
            // strings (routes.ts:81-88), and a cached entity would come back
            // through JSON.parse as strings the Zod response serializer never
            // saw — a different body for the same user.
            cacheGateway.set(state.key, ME_KEY_PREFIX, JSON.parse(payload), ME_CACHE_TTL_SECONDS),
          ),
        );
      }

      return payload;
    });
  }
  ```

  > **Note:** `cacheGateway.set` receives `JSON.parse(payload)` rather than the raw string, so the
  > stored value is a JSON object and `CacheGateway.get` returns it via a matching `JSON.parse` —
  > a symmetric round trip. The hit path then re-serializes with `JSON.stringify`. Key ordering is
  > preserved by both operations, which is what makes test (2)'s `hit.body === miss.body`
  > assertion hold. Storing `payload` verbatim as a string would double-encode on the way back out.

- [ ] **Step 20: Attach the hooks and export `serializeUser`.**
  In `services/users/src/features/users/http/routes.ts`:

  1. Add the import beside the other feature-local imports (after `:18`):
     ```ts
     import { registerMeCacheHooks } from "./cache-hooks.ts";
     ```
  2. Export `serializeUser` — change `function serializeUser(user: User) {` (`:81`) to
     `export function serializeUser(user: User) {`. Nothing else changes; the hooks do not call it
     (they cache the serialized payload from `onSend`), but exporting it makes the shape testable
     and documents that the cached value is *that* function's output.
  3. Register the hook pair immediately after the existing `onResponse` hook block ends
     (`routes.ts:219`, the `});` closing `app.addHook("onResponse", ...)`) and before
     `app.setValidatorCompiler(...)` (`:221`):
     ```ts
     // The response cache for GET /v1/users/me: a preHandler/onSend pair, the
     // FIRST hooks of either kind in this service (until now it had exactly two
     // global hooks, onRequest and onResponse). See cache-hooks.ts for the two
     // traps that live in them — the key needing CurrentUser.resolve(), and
     // @fastify/otel nulling the span inside onSend.
     registerMeCacheHooks(app);
     ```

- [ ] **Step 21: Invalidate on `PATCH /v1/users/me`.**
  In `routes.ts`, replace the `PATCH /v1/users/me` handler body (`:503-509`) with:

  ```ts
    }, async (req, reply) => {
      const { updateProfileCommand, currentUser, currentActor, cacheGateway } = req.diScope.cradle;
      const updated = await updateProfileCommand.execute(currentUser, req.body);
      if (!updated) return reply.code(404).send({ error: "not_found" });

      // AFTER the write has persisted, never before. Invalidating first opens a
      // window in which a concurrent read repopulates the OLD value between the
      // delete and the write landing — the entry would then be stale for the
      // full 5 minutes with nothing left to clear it.
      //
      // `currentActor` is the raw x-user-id, which is what the key was built
      // from on the read path; `updated.id` is the resolved user_id. Both halves
      // must match the read-side key exactly or this deletes nothing.
      await cacheGateway.invalidate(ME_KEY_PREFIX, meCacheKey(currentActor as string, updated.id));

      return reply.send(serializeUser(updated));
    });
  ```

  Add to `routes.ts`'s imports:
  ```ts
  import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";
  ```

- [ ] **Step 22: Invalidate on `PATCH /v1/users/me/password`.**
  In `routes.ts`, replace the `PATCH /v1/users/me/password` handler body (`:533-539`) with:

  ```ts
    }, async (req, reply) => {
      const { changePasswordCommand, currentUser, currentActor, cacheGateway } = req.diScope.cradle;
      const updated = await changePasswordCommand.execute(currentUser, req.body);
      if (!updated) return reply.code(404).send({ error: "not_found" });

      // ==== WHY A PASSWORD CHANGE INVALIDATES THE PROFILE CACHE ====
      // Nothing password-related is ever cached. But this command CLEARS
      // `mustChangePassword` (change-password.ts:114-121), and that flag is a
      // field of UserSchema (schemas.ts:115) and therefore part of the cached
      // GET /v1/users/me body. Without this line the frontend keeps reading
      // `mustChangePassword: true` for up to five minutes after the user has
      // already changed it, and sends them round the forced-change flow again.
      await cacheGateway.invalidate(ME_KEY_PREFIX, meCacheKey(currentActor as string, updated.id));

      return reply.send(serializeUser(updated));
    });
  ```

- [ ] **Step 23: Run the hook test and confirm it passes.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users test -- tests/features/users/http/cache-hooks.test.ts`
  Expected: `Test Files 1 passed`, `Tests 10 passed` — the eight required cases plus the two
  `cache_result` logging assertions.

- [ ] **Step 24: Run the whole Users suite and confirm nothing regressed.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users test`
  Expected: all files pass. Pay attention to `tests/features/users/http/routes.test.ts` — it
  injects `GET /v1/users/me` and `PATCH /v1/users/me` against containers that register **no**
  `cacheGateway`. Those tests must still pass, because the preHandler resolves `cacheGateway`
  from the cradle. If they fail with `AwilixResolutionError: Could not resolve 'cacheGateway'`,
  fix it in `cache-hooks.ts` by guarding the resolution the same way the `onResponse` hook guards
  its `metricsPublisher` resolution (`routes.ts:203-214`, a `try`/`catch` whose comment explains
  that a test container registering no publisher must not turn into a request error):

  ```ts
  function resolveGateway(req: FastifyRequest): CacheGateway | undefined {
    try {
      return req.diScope.cradle.cacheGateway;
    } catch {
      // A test container that registers no cacheGateway. Resolution itself
      // throws, and an observation of a request must never become an error of
      // its own — same stance as the onResponse hook's metricsPublisher.
      return undefined;
    }
  }
  ```
  …and start both hooks with `const cacheGateway = resolveGateway(req); if (cacheGateway === undefined) return;`.

- [ ] **Step 25: Commit the interceptor and its invalidation.**
  `git add services/users/src/features/users/http/cache-hooks.ts services/users/src/features/users/http/routes.ts services/users/tests/features/users/http/cache-hooks.test.ts && git commit -m "feat(users): cache GET /v1/users/me and invalidate it on every profile write"`

- [ ] **Step 26: Write the failing E2E-cleanup invalidation test.**
  There is **no user-deletion event to hook into anywhere in this repo** — verified, and the spec
  records it as a decision rather than a gap. `cognito-payload.ts:16-21` accepts exactly two
  `triggerSource` values (`PostConfirmation_ConfirmSignUp`, `PostConfirmation_ConfirmForgotPassword`),
  and the only deletion path in the service is `E2eCleanupCommand`
  (`services/users/src/features/users/http/e2e-cleanup.ts:7`), a soft-delete gated on
  `E2E_TESTING_ENABLED`. **Do not invent an invalidation hook for an account-deletion event that
  does not exist** — that endpoint, with its cascade into Orders and Tracking, is explicitly
  deferred to its own milestone.

  `E2eCleanupCommand` *does* need one, though: without it an E2E run soft-deletes its users and the
  next run's `GET /v1/users/me` can still be served a cached profile for a user the database now
  reports as gone. Append to `services/users/tests/features/users/commands/` — create
  `services/users/tests/features/users/http/e2e-cleanup.test.ts`:

  ```ts
  import { describe, it, expect, vi } from "vitest";
  import { E2eCleanupCommand } from "#features/users/http/e2e-cleanup";
  import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";

  function makeDeps(rows: Array<{ id: string; cognitoSub: string | null }>) {
    const invalidate = vi.fn(async () => {});
    const db = {
      user: {
        findMany: vi.fn(async () => rows),
        deleteMany: vi.fn(async () => ({ count: rows.length })),
      },
    };
    return { db, cacheGateway: { invalidate } as any, invalidate };
  }

  describe("E2eCleanupCommand cache invalidation", () => {
    it("drops each deleted user's cached profile", async () => {
      const d = makeDeps([
        { id: "usr_a", cognitoSub: "sub-a" },
        { id: "usr_b", cognitoSub: "sub-b" },
      ]);
      const command = new E2eCleanupCommand(d as any);

      const res = await command.execute();

      expect(res).toEqual({ count: 2 });
      expect(d.invalidate).toHaveBeenCalledWith(
        ME_KEY_PREFIX,
        meCacheKey("sub-a", "usr_a"),
        meCacheKey("sub-b", "usr_b"),
      );
    });

    it("skips a row with no cognitoSub rather than building a key with 'null' in it", async () => {
      // A user captured before the Cognito webhook fired has no sub, so no read
      // ever cached them under one. `users:me:v1:null:usr_c` would be a key that
      // matches nothing — a silent no-op that reads like a working invalidation.
      const d = makeDeps([{ id: "usr_c", cognitoSub: null }]);
      const command = new E2eCleanupCommand(d as any);

      await command.execute();

      expect(d.invalidate).not.toHaveBeenCalled();
    });

    it("still reports the deletion count when the cache call fails", async () => {
      const d = makeDeps([{ id: "usr_a", cognitoSub: "sub-a" }]);
      d.cacheGateway.invalidate = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
      const command = new E2eCleanupCommand(d as any);

      // The soft-delete has already persisted; a cache failure must not undo it.
      await expect(command.execute()).resolves.toEqual({ count: 1 });
    });
  });
  ```

- [ ] **Step 27: Run the E2E-cleanup test and confirm it fails for the right reason.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users test -- tests/features/users/http/e2e-cleanup.test.ts`
  Expected: the first test fails with `expected "spy" to be called with arguments: [...]. Received: Number of calls: 0`
  — the command does not touch the cache yet. The second test passes vacuously (also 0 calls) and
  the third passes; only the first is red, which is correct.

- [ ] **Step 28: Invalidate from `E2eCleanupCommand`.**
  Replace `services/users/src/features/users/http/e2e-cleanup.ts` with:

  ```ts
  import type { Db } from "#shared/db/prisma";
  import type { CacheGateway } from "#shared/cache/cache-gateway";
  import { runAsActor } from "#shared/audit/actor-context";
  import { AuditActor } from "#shared/audit/audit-actor";
  import { ME_KEY_PREFIX, meCacheKey } from "#shared/cache/cache-keys";

  // Constructor-injected from the Awilix cradle (PROXY injection mode).
  // Soft-deletes (never hard-deletes) every user tagged "E2E Source".
  export class E2eCleanupCommand {
    private readonly db: Db;
    private readonly cacheGateway: CacheGateway;

    constructor({ db, cacheGateway }: { db: Db; cacheGateway: CacheGateway }) {
      this.db = db;
      this.cacheGateway = cacheGateway;
    }

    async execute(): Promise<{ count: number }> {
      // Read the rows BEFORE deleting them: the cache key needs both `id` and
      // `cognitoSub`, and after the soft-delete the query extension filters
      // these rows out of every find* (see [[soft-delete]]), so they would be
      // unreachable.
      const doomed = (await this.db.user.findMany({
        where: { tags: { has: "E2E Source" }, deletedAt: null },
        select: { id: true, cognitoSub: true },
      })) as Array<{ id: string; cognitoSub: string | null }>;

      // `deleteMany` is redirected to a soft-delete update by the Prisma
      // extension (see [[soft-delete]]); `runAsActor` sets a fixed actor for
      // this call instead of relying on the request's `x-user-id` (this
      // maintenance endpoint isn't tied to an authenticated user).
      //
      // `deletedAt: null` is what keeps the count meaningful. The extension
      // injects that filter into `find*` but NOT into `deleteMany` — it forwards
      // `where` verbatim to `updateMany` — so without it this re-stamps every
      // row it has ever deleted and returns a running total of all history.
      // The E2E teardown prints that number, and it climbed every run (590 →
      // 643 → …) when it should report what the run just created. Re-deleting
      // was harmless but told you nothing.
      const res = (await runAsActor(AuditActor.E2eCleanup, () =>
        this.db.user.deleteMany({
          where: { tags: { has: "E2E Source" }, deletedAt: null },
        }),
      )) as { count: number };

      // AFTER the delete has persisted, like every other invalidation in this
      // service. Without it an E2E run leaves cached profiles for users the
      // database now reports as gone, and the NEXT run reads them for up to five
      // minutes — a stale-data failure that looks like a test flake.
      //
      // Rows with no `cognitoSub` are skipped: no read ever cached them (the key
      // needs a sub), and a `users:me:v1:null:usr_x` key would match nothing
      // while reading like a working invalidation.
      const keys = doomed
        .filter((row): row is { id: string; cognitoSub: string } => row.cognitoSub !== null)
        .map((row) => meCacheKey(row.cognitoSub, row.id));
      if (keys.length > 0) {
        // `invalidate` swallows its own failures (see CacheGateway), so the
        // soft-delete's count is reported regardless of Redis's state.
        await this.cacheGateway.invalidate(ME_KEY_PREFIX, ...keys);
      }

      return { count: res.count };
    }
  }
  ```

  > **Note:** the third test in Step 26 injects a `cacheGateway` whose `invalidate` *throws*, which
  > the real `CacheGateway.invalidate` never does — it swallows internally. The test asserts the
  > *command's* contract holds even against a hostile collaborator, so `execute()` must not let the
  > rejection escape. If it does, wrap the call in `try { … } catch { /* the delete already
  > persisted */ }`.

- [ ] **Step 29: Run the E2E-cleanup test and confirm it passes.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users test -- tests/features/users/http/e2e-cleanup.test.ts`
  Expected: `Test Files 1 passed`, `Tests 3 passed`.

- [ ] **Step 30: Write the failing metric-seeding test.**
  Append to `services/users/tests/shared/metrics/business-metrics.test.ts`, inside the existing
  `describe("BusinessMetricsPoller", ...)` block:

  ```ts
    // The cache counters are emitted only from a cached read, so on a service
    // that has just booted — or during a quiet window on a dashboard's time
    // range — the series does not exist and OpenObserve renders "Error Loading
    // Data" instead of a readable zero. The reasoning is spelled out at
    // business-metrics.ts:156-195 for the error and business counters; the cache
    // counters have exactly the same shape and need exactly the same seeding.
    //
    // hit/miss/bypass are seeded, but NOT cache_operation_duration_ms: that one
    // is a duration, and a seeded 0ms would drag every average and percentile
    // toward zero — the panel would read "fast" precisely when nothing ran.
    it("seeds cache_requests_total at zero for every Result value", async () => {
      const d = makeDeps({ password: 1, passwordless: 1 });
      const poller = new BusinessMetricsPoller(d as any);

      await poller.collectAndPublish();

      for (const result of ["hit", "miss", "bypass"]) {
        expect(d.publish).toHaveBeenCalledWith("cache_requests_total", 0, {
          Service: "users",
          KeyPrefix: "users:me:v1",
          Result: result,
        });
      }
    });

    it("does NOT seed the duration histogram", async () => {
      const d = makeDeps({ password: 1, passwordless: 1 });
      const poller = new BusinessMetricsPoller(d as any);

      await poller.collectAndPublish();

      expect(d.publish).not.toHaveBeenCalledWith(
        "cache_operation_duration_ms",
        0,
        expect.anything(),
        expect.anything(),
      );
    });
  ```

- [ ] **Step 31: Run the metrics test and confirm it fails for the right reason.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users test -- tests/shared/metrics/business-metrics.test.ts`
  Expected: the seeding test fails with
  `expected "spy" to be called with arguments: [ 'cache_requests_total', 0, {…} ]` — the poller
  does not publish it yet. The "does NOT seed" test passes already (vacuously), which is fine.

- [ ] **Step 32: Seed the cache counters in the poller.**
  In `services/users/src/shared/metrics/business-metrics.ts`, inside `collectAndPublishTick()`,
  after the existing business-counter seeding block (`:192-195`) and before `return { withPassword, withoutPassword };`
  (`:197`):

  ```ts
      // The cache counters get the same seeding as the error and business
      // counters above, for the reason spelled out there: a panel over a series
      // that has no datapoint in the selected window does not render "0" — it
      // throws and shows "Error Loading Data". So the hit-rate card breaks
      // exactly when the answer is "nobody read a profile in the last five
      // minutes", which is the least alarming answer there is.
      //
      // `bypass` is seeded alongside hit/miss even though it should stay at zero
      // in a healthy system — a card that reads "Error Loading Data" until the
      // first Redis outage is a card nobody trusts when the outage arrives.
      //
      // NOT seeded: cache_operation_duration_ms. That is a duration, and a
      // synthetic 0ms every tick would pull every average and percentile toward
      // zero, reporting a fast cache precisely when nothing is being cached.
      // Seeding a COUNTER is arithmetically free (CloudWatch sums within a
      // period); seeding a duration is a lie.
      await Promise.all(
        (["hit", "miss", "bypass"] as const).map((result) =>
          this.metrics.publish("cache_requests_total", 0, {
            Service: "users",
            // The PREFIX, never a key — the same rule the gateway follows. Users
            // has exactly one cached endpoint, so this list is exactly one entry
            // long; a second cached route would add its prefix here.
            KeyPrefix: ME_KEY_PREFIX,
            Result: result,
          }),
        ),
      );
  ```

  Add the import at the top of `business-metrics.ts`, relative per the `src/shared/**` convention:
  ```ts
  import { ME_KEY_PREFIX } from "../cache/cache-keys.ts";
  ```

- [ ] **Step 33: Run the metrics test and confirm it passes.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users test -- tests/shared/metrics/business-metrics.test.ts`
  Expected: every test in the file passes, including the two added ones.

- [ ] **Step 34: Typecheck and lint.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users build && pnpm --filter @3mrai/users lint`
  Expected: `tsc` emits nothing and exits 0; eslint reports no errors. `build` is the only gate that
  catches a `Cradle` augmentation mistake — vitest runs through esbuild and never typechecks, which
  is precisely how the `metricsPublisher` resolution bug reached production
  (`tests/shared/di/metrics-registrations.test.ts:10-13`).

- [ ] **Step 35: Run the full Users suite one final time.**
  `cd services/users && nvm use && pnpm --filter @3mrai/users test`
  Expected: every test file passes, with the new counts included. State the actual `Tests N passed`
  figure in the commit — do not claim green without having seen this output.

- [ ] **Step 36: Commit the remaining work.**
  `git add services/users/src/features/users/http/e2e-cleanup.ts services/users/src/shared/metrics/business-metrics.ts services/users/tests/features/users/http/e2e-cleanup.test.ts services/users/tests/shared/metrics/business-metrics.test.ts && git commit -m "feat(users): invalidate the profile cache on E2E cleanup and seed the cache counters"`
  Leave the work in the branch. Per the repo's git rule, do not push and do not open a PR — the
  main session presents the batch for review at the milestone's stop point.

---
### Task 6: E2E coverage (internal + gateway) and the cache A/B load test

The final task of the caching milestone. Tasks 2-5 built the interceptor, the invalidator and
the identity cache inside Orders (.NET), Tracking (FastAPI) and Users (Fastify), each with its
own unit/integration tests — layer 1 of [[testing]]. This task adds the two OUTER layers
(internal E2E and gateway E2E) plus the Gatling A/B load simulation the design spec calls for.

**Why the gateway layer is not redundant with the internal one, stated once so nobody deletes
it as duplication:** an API Gateway or an nginx `location` block can silently strip a response
header it does not know about, and that failure is **completely invisible from the service
port**. The internal specs would stay green while `X-Cache` never reached a single real client.
`docs/shared/conventions/testing.md` and each service's `CLAUDE.md` §2b both make this
mandatory: an endpoint without gateway E2E is an incomplete change.

**Header contract under test** (from `docs/shared/conventions/x-cache-response-header.md`):

| Value | Companion header | When |
|---|---|---|
| `X-Cache: HIT` | `X-Cache-TTL: <seconds remaining>` | served from Redis, handler skipped |
| `X-Cache: MISS` | none | not in Redis, handler ran, 200 populated the cache |
| `X-Cache: BYPASS` | none | Redis unavailable, fell through to the DB |
| *(no header at all)* | none | `CACHE_ENABLED=false` |

**Files:**

- Create: `e2e/tests/cache.spec.ts` — internal E2E, Playwright project `internal`, covering all
  seven cached endpoints across the three services on their direct ports (Users `:3000`,
  Orders `:3001`, Tracking `:3002`).
- Create: `e2e/tests/gateway/cache.spec.ts` — gateway E2E, Playwright project `gateway`, real
  Cognito JWT through `API_GATEWAY_URL`, asserting `X-Cache`/`X-Cache-TTL` survive the API
  Gateway **and** nginx.
- Create: `e2e/support/cache-headers.ts` — the two assertion helpers every cache spec uses
  (`expectMiss`, `expectHit`), so the header contract is spelled out in exactly one place.
- Create: `e2e/load-tests/src/scenarios/cache.ts` — Gatling steps that read each cached
  endpoint twice and capture the `X-Cache` header into named request rows.
- Create: `e2e/load-tests/src/cacheAB.gatling.ts` — the A/B simulation.
- Modify: `e2e/load-tests/package.json` — add the `cache-ab` script.
- Modify: `e2e/load-tests/README.md` — document the two-run A/B procedure.
- Modify: `Makefile` — add `load-test-cache-ab-on`, `load-test-cache-ab-off` and
  `cache-toggle` targets so the operator flips the flag and reruns without hand-editing files.
- Modify: `e2e/CLAUDE.md` §2 — list the new `cache-ab` script alongside `smoke`/`load`/`users`/
  `auth-codes`.

**Interfaces:**

- *Consumes:* `apiClient()` / `ordersClient()` / `trackingClient()` from
  `e2e/support/api-client.ts` (direct service contexts, each already sending
  `X-E2E-Source: true`); `getGatewayToken()` from `e2e/support/auth.ts` (register + login
  through the gateway, returns `{ token, email }`); `gatewayClient(token)` from
  `e2e/support/gateway-client.ts` (baseURL normalized with a trailing slash — **relative
  request paths only**, no leading slash); `makeUser()` from `e2e/support/chance-factory.ts`;
  `baseUrl()` / `profile` / `fakeUser()` from `e2e/load-tests/src/support/config.ts`; the
  existing load scenario steps in `e2e/load-tests/src/scenarios/{users,orders,tracking,cart}.ts`.
- *Produces:* `expectMiss(response)` / `expectHit(response)` in
  `e2e/support/cache-headers.ts`; the `cacheAB` Gatling simulation, runnable as
  `pnpm exec gatling run --typescript --simulation cacheAB`.

---

- [ ] **Step 1: Confirm the stack is up and the cache flag is readable.**

  Run, from the repo root:

  ```bash
  make ps && grep -h '^CACHE_ENABLED=' .env.local.orders .env.local.tracking .env.local.users
  ```

  Expected: `make ps` lists `users`, `orders`, `tracking` and `floci` as `Up`; the grep prints
  exactly three lines, `CACHE_ENABLED=true` once per file. If `make ps` shows nothing running,
  run `make bootstrap` first (a multi-minute full provision — Floci + terraform apply +
  migrations + compose). If the grep prints fewer than three lines, Task 1 is not merged into
  your branch and every spec below will fail for the wrong reason.

  > **Note:** `CACHE_ENABLED` lives in the **CUSTOM** box of each generated env file, which
  > `infra/environments/local/scripts/generate_env_files.py` preserves verbatim across runs
  > (`custom_defaults=` at lines 334/377/432 seed it; the "CUSTOM sections preserved" message at
  > line 550 is the guarantee). That is why flipping it survives `make env-file`, and why you
  > must never move it into the AUTO box.

- [ ] **Step 2: Confirm Redis is reachable, so a spurious `BYPASS` is ruled out before writing
      any assertion.**

  Run:

  ```bash
  docker ps --filter 'name=floci-valkey' --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
  ```

  Expected: one line naming a `floci-valkey-<id>` container with status `Up`, publishing a port
  in the `6379-6399` range. If nothing is listed, every spec below will see `X-Cache: BYPASS`
  instead of `MISS`/`HIT` — fail-open is working exactly as designed and the specs are correct
  to fail. Fix the stack (`make clean && make bootstrap`) before continuing; do not weaken the
  assertions to accept `BYPASS`.

- [ ] **Step 3: Create `e2e/support/cache-headers.ts` with the two shared assertion helpers.**

  ```ts
  import { expect, type APIResponse } from "@playwright/test";

  // The X-Cache contract, asserted from ONE place so a spec can never quietly
  // encode a weaker version of it. Full contract:
  // docs/shared/conventions/x-cache-response-header.md.
  //
  // Header lookup is case-insensitive: Playwright's headers() lowercases every
  // key, and asserting on "X-Cache" (mixed case) silently reads `undefined`
  // regardless of what the service actually sent — a spec that passes while
  // proving nothing. Always read the lowercase spelling.

  function cacheHeader(res: APIResponse): string | undefined {
    return res.headers()["x-cache"];
  }

  function cacheTtlHeader(res: APIResponse): string | undefined {
    return res.headers()["x-cache-ttl"];
  }

  /**
   * A cold read: the handler ran and (on a 200) populated the cache.
   *
   * BYPASS is explicitly named in the failure message because it is the ONE
   * outcome that looks like a cache bug and is not: it means Redis was
   * unreachable and the service failed open exactly as designed. Naming it here
   * saves the reader from debugging the interceptor when the actual problem is a
   * stopped container.
   */
  export function expectMiss(res: APIResponse, what: string): void {
    const value = cacheHeader(res);
    expect(
      value,
      `${what}: expected X-Cache: MISS, got ${value ?? "no X-Cache header at all"}. ` +
        "BYPASS means Redis was unreachable (fail-open, not a cache bug) — check the " +
        "floci-valkey container. No header at all means CACHE_ENABLED=false for that service.",
    ).toBe("MISS");
    // A MISS carries NO TTL header — there is nothing cached yet to have a
    // remaining lifetime.
    expect(cacheTtlHeader(res), `${what}: a MISS must not carry X-Cache-TTL`).toBeUndefined();
  }

  /**
   * A warm read: served from Redis, the handler never executed.
   *
   * Asserts the TTL header too, and asserts it as a NUMBER in a plausible range
   * rather than merely being present — a header stuck at "0" or carrying a
   * non-numeric string would pass a presence check while telling every client
   * something false.
   */
  export function expectHit(res: APIResponse, what: string, maxTtlSeconds: number): void {
    const value = cacheHeader(res);
    expect(
      value,
      `${what}: expected X-Cache: HIT, got ${value ?? "no X-Cache header at all"}. ` +
        "A MISS here means the entry expired or was invalidated between the two reads.",
    ).toBe("HIT");

    const ttl = cacheTtlHeader(res);
    expect(ttl, `${what}: a HIT must carry X-Cache-TTL`).toBeDefined();
    const seconds = Number(ttl);
    expect(Number.isFinite(seconds), `${what}: X-Cache-TTL is not numeric: ${ttl}`).toBe(true);
    expect(seconds, `${what}: X-Cache-TTL must be positive`).toBeGreaterThan(0);
    // Never larger than the key's configured TTL — a value above it means the
    // wrong TTL was written, which a presence-only check would never notice.
    expect(
      seconds,
      `${what}: X-Cache-TTL ${seconds}s exceeds the configured ${maxTtlSeconds}s TTL`,
    ).toBeLessThanOrEqual(maxTtlSeconds);
  }

  /** No cache layer at all — what `CACHE_ENABLED=false` must produce. */
  export function expectNoCacheHeaders(res: APIResponse, what: string): void {
    expect(cacheHeader(res), `${what}: X-Cache must be absent when caching is off`).toBeUndefined();
    expect(cacheTtlHeader(res), `${what}: X-Cache-TTL must be absent when caching is off`).toBeUndefined();
  }
  ```

- [ ] **Step 4: Type-check the new helper before any spec depends on it.**

  ```bash
  nvm use && pnpm --filter @3mrai/e2e typecheck
  ```

  Expected: exits 0 with no output (the package script is `tsc --noEmit`). A `TS2307` here means
  the import path is missing its `.js` extension — this package is `"type": "module"` and every
  local import in `e2e/` carries `.js`, even from a `.ts` source.

- [ ] **Step 5: Create `e2e/tests/cache.spec.ts` with its header comment and the shared TTL
      table.**

  Write only this preamble first; the tests come in the following steps.

  ```ts
  import { test, expect } from "@playwright/test";
  import { apiClient, ordersClient, trackingClient } from "../support/api-client.js";
  import { makeUser } from "../support/chance-factory.js";
  import { carrierHeaders } from "../support/tracking-carrier-key.js";
  import { expectHit, expectMiss } from "../support/cache-headers.js";

  // Internal E2E for the response cache: two consecutive GETs must produce
  // MISS then HIT, and an intervening write must return the next read to MISS.
  // Direct service ports, `x-user-id` faked — the gateway path is covered
  // separately by tests/gateway/cache.spec.ts, which exists for one specific
  // reason the internal layer structurally cannot see: a gateway or an nginx
  // location block can silently strip an unknown RESPONSE header, and from the
  // service port that failure is invisible.
  //
  // ## Why every test registers its OWN caller
  //
  // Six of the seven cache keys carry `{sub}:{user_id}`
  // (docs/shared/conventions/x-cache-response-header.md). A shared caller would
  // let one test's warm cache satisfy another test's "cold read" assertion, and
  // that contamination is order-dependent — the suite would pass alone and fail
  // in a full run. A fresh caller per test makes every first read genuinely cold
  // by construction. `orders:products:v1` is the one shared, ownerless key, and
  // it is handled explicitly below rather than pretended otherwise.
  //
  // ## Speed is a CORRECTNESS property here, not a nicety
  //
  // TTLs are short — 60s for the cart and both tracking keys. A MISS/HIT pair
  // separated by more than the TTL fails INTERMITTENTLY, and the failure reads as
  // a cache bug rather than a test bug, which is the expensive kind of flake.
  // Therefore:
  //   - the two reads of a pair are ISSUED BACK TO BACK, with nothing between
  //     them (no registration, no product lookup, no polling);
  //   - everything a pair needs — caller, product, order, tracking — is set up
  //     BEFORE the first read;
  //   - there is NO `waitForTimeout` anywhere in this file. Sleeping to "let the
  //     cache settle" is precisely what pushes a pair over a 60s boundary. The
  //     cache is populated synchronously by the MISS response before that
  //     response is returned, so there is nothing to wait for.
  // TTL EXPIRY is deliberately NOT tested at this layer: the only honest way to
  // test it is to wait out a real TTL, which would add minutes to the suite. It
  // is covered in layer 1 (unit/integration) with a clock the tests control.

  // Configured TTLs, in seconds, from the spec's key table. Used as the UPPER
  // bound on X-Cache-TTL — a larger value means the wrong TTL was written.
  const TTL = {
    products: 600, // orders:products:v1              — 10 min
    cart: 60, //     orders:cart:v1:{sub}:{user_id}   — 60 s
    myOrders: 120, // orders:my-orders:v1:...:t{0|1}  — 2 min
    order: 120, //    orders:order:v1:...:t{0|1}      — 2 min
    tracking: 60, //  tracking:order:v1:...           — 60 s
    trackingList: 60, // tracking:list:v1:...         — 60 s
    me: 300, //       users:me:v1:{sub}:{user_id}     — 5 min
  } as const;

  // Registers a throwaway caller against Users and returns its `usr_` id, used
  // as the faked `x-user-id` everywhere below. Same helper shape as
  // orders.spec.ts / cart.spec.ts — Users' gRPC GetUserById resolves by `usr_`
  // id OR Cognito sub, so this one value works as `x-user-id` against all three
  // services.
  async function registerCaller(): Promise<string> {
    const users = await apiClient();
    const res = await users.post("/v1/users/register", { data: makeUser() });
    expect(res.status(), `register failed: ${await res.text()}`).toBe(201);
    const { id } = await res.json();
    return id as string;
  }

  async function firstProductWithStock(
    api: Awaited<ReturnType<typeof ordersClient>>,
    userId: string,
  ): Promise<{ id: string; unitsInStock: number }> {
    const products = await api.get("/v1/products", { headers: { "x-user-id": userId } });
    expect(products.status()).toBe(200);
    const product = (await products.json()).find((p: { unitsInStock: number }) => p.unitsInStock > 0);
    expect(product, "no product with stock in the catalogue").toBeTruthy();
    return product;
  }
  ```

- [ ] **Step 6: Add the `GET /v1/products` tests to `e2e/tests/cache.spec.ts`.**

  Append:

  ```ts
  // `orders:products:v1` is the ONE key with no owner in it — a shared catalogue
  // entry, 10-minute TTL. That makes it the only endpoint here where a previous
  // test (or a previous RUN) may legitimately have left the entry warm, so the
  // first read cannot be asserted as a MISS. The honest assertion is the pair
  // relationship: whatever the first read reports, the second must be a HIT.
  test("GET /v1/products: the catalogue is cached — a second read is a HIT", async () => {
    const api = await ordersClient();
    const userId = await registerCaller();

    const first = await api.get("/v1/products", { headers: { "x-user-id": userId } });
    expect(first.status()).toBe(200);
    expect(
      first.headers()["x-cache"],
      "the shared catalogue key may legitimately be warm from an earlier test, so MISS or HIT " +
        "are both correct here — but the header must be present, and must not be BYPASS",
    ).toMatch(/^(MISS|HIT)$/);

    const second = await api.get("/v1/products", { headers: { "x-user-id": userId } });
    expect(second.status()).toBe(200);
    expectHit(second, "second GET /v1/products", TTL.products);
    // The cached body must be byte-identical to what the handler produced —
    // a HIT that serves a different shape is worse than no cache at all.
    expect(await second.json()).toEqual(await first.json());
  });

  // Ordering a product decrements stock, so `orders:products:v1` must be
  // invalidated by POST /v1/orders (spec's invalidation matrix). This is the one
  // test that intentionally perturbs the shared key, so it does its cold read
  // AFTER the write rather than before.
  test("POST /v1/orders invalidates the catalogue: the next GET /v1/products is a MISS", async () => {
    const api = await ordersClient();
    const userId = await registerCaller();
    const product = await firstProductWithStock(api, userId);

    // Warm it deliberately, so the assertion below is about invalidation and not
    // about the key merely being cold.
    const warm = await api.get("/v1/products", { headers: { "x-user-id": userId } });
    expect(warm.status()).toBe(200);

    const created = await api.post("/v1/orders", {
      headers: { "x-user-id": userId },
      data: { lines: [{ productId: product.id, quantity: 1 }] },
    });
    expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);

    const after = await api.get("/v1/products", { headers: { "x-user-id": userId } });
    expect(after.status()).toBe(200);
    expectMiss(after, "GET /v1/products after POST /v1/orders");
  });
  ```

- [ ] **Step 7: Add the `GET /v1/cart` tests to `e2e/tests/cache.spec.ts`.**

  Append:

  ```ts
  test("GET /v1/cart: MISS then HIT for the same caller", async () => {
    const api = await ordersClient();
    const userId = await registerCaller();
    const product = await firstProductWithStock(api, userId);

    // All setup finished BEFORE the pair, so the two reads are adjacent in time
    // and cannot straddle the 60s TTL.
    const put = await api.put("/v1/cart", {
      headers: { "x-user-id": userId },
      data: { items: [{ productId: product.id, quantity: 1 }] },
    });
    expect(put.status()).toBe(200);

    const first = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
    expect(first.status()).toBe(200);
    expectMiss(first, "first GET /v1/cart");

    const second = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
    expect(second.status()).toBe(200);
    expectHit(second, "second GET /v1/cart", TTL.cart);
    expect(await second.json()).toEqual(await first.json());
  });

  test("PUT /v1/cart invalidates the cart key: the next GET is a MISS with the new contents", async () => {
    const api = await ordersClient();
    const userId = await registerCaller();
    const product = await firstProductWithStock(api, userId);

    await api.put("/v1/cart", {
      headers: { "x-user-id": userId },
      data: { items: [{ productId: product.id, quantity: 1 }] },
    });
    const warm = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
    expectMiss(warm, "first GET /v1/cart");
    const hit = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
    expectHit(hit, "second GET /v1/cart", TTL.cart);

    // The intervening write.
    const update = await api.put("/v1/cart", {
      headers: { "x-user-id": userId },
      data: { items: [{ productId: product.id, quantity: 3 }] },
    });
    expect(update.status()).toBe(200);

    const after = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
    expect(after.status()).toBe(200);
    expectMiss(after, "GET /v1/cart after PUT /v1/cart");
    // Header AND body: a stale HIT and a fresh MISS serving stale contents are
    // different bugs, and only checking the header would catch one of them.
    const cart = await after.json();
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(3);
  });

  test("DELETE /v1/cart invalidates the cart key", async () => {
    const api = await ordersClient();
    const userId = await registerCaller();
    const product = await firstProductWithStock(api, userId);

    await api.put("/v1/cart", {
      headers: { "x-user-id": userId },
      data: { items: [{ productId: product.id, quantity: 1 }] },
    });
    expectMiss(await api.get("/v1/cart", { headers: { "x-user-id": userId } }), "first GET /v1/cart");

    const deleted = await api.delete("/v1/cart", { headers: { "x-user-id": userId } });
    expect(deleted.status()).toBe(204);

    const after = await api.get("/v1/cart", { headers: { "x-user-id": userId } });
    expect(after.status()).toBe(200);
    expectMiss(after, "GET /v1/cart after DELETE /v1/cart");
    expect((await after.json()).id).toBeNull();
  });

  // Cross-user isolation at the E2E layer. Layer 1 asserts it against the key
  // builder; this asserts it against the running service, which is where an
  // interceptor that forgot to include the caller in the key would actually show
  // up — as user B receiving a HIT on user A's warm entry.
  test("GET /v1/cart: user B never gets a HIT on user A's warm cart", async () => {
    const api = await ordersClient();
    const userA = await registerCaller();
    const userB = await registerCaller();
    const product = await firstProductWithStock(api, userA);

    await api.put("/v1/cart", {
      headers: { "x-user-id": userA },
      data: { items: [{ productId: product.id, quantity: 1 }] },
    });
    expectMiss(await api.get("/v1/cart", { headers: { "x-user-id": userA } }), "user A first read");
    expectHit(await api.get("/v1/cart", { headers: { "x-user-id": userA } }), "user A second read", TTL.cart);

    const asB = await api.get("/v1/cart", { headers: { "x-user-id": userB } });
    expect(asB.status()).toBe(200);
    expectMiss(asB, "user B's first read must not hit user A's entry");
    expect((await asB.json()).items).toEqual([]);
  });
  ```

- [ ] **Step 8: Add the `my-orders` tests — BOTH `includeTracking` variants — to
      `e2e/tests/cache.spec.ts`.**

  Append:

  ```ts
  // ## The includeTracking trap, and why both variants get their own pair
  //
  // `?includeTracking=true` and `=false` are DIFFERENT cache keys —
  // `orders:my-orders:v1:{sub}:{user_id}:t1` and `...:t0` — returning DIFFERENT
  // response shapes (the `true` variant fans out to Tracking's batch endpoint and
  // embeds the tracking in each order). A spec that warmed one variant and then
  // asserted a HIT on the other would be asserting a BUG: it would only pass if
  // the key ignored the parameter, which is exactly the defect the `t{0|1}`
  // segment exists to prevent. So each variant is warmed and asserted
  // independently, and one extra assertion proves they are genuinely separate
  // entries rather than one shared entry that happens to look right.
  test("GET /v1/orders/my-orders: MISS then HIT, per includeTracking variant", async () => {
    const api = await ordersClient();
    const userId = await registerCaller();
    const product = await firstProductWithStock(api, userId);
    const created = await api.post("/v1/orders", {
      headers: { "x-user-id": userId },
      data: { lines: [{ productId: product.id, quantity: 1 }] },
    });
    expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);

    // Variant t0 — the default.
    const t0First = await api.get("/v1/orders/my-orders", { headers: { "x-user-id": userId } });
    expect(t0First.status()).toBe(200);
    expectMiss(t0First, "first GET /v1/orders/my-orders (includeTracking omitted)");
    const t0Second = await api.get("/v1/orders/my-orders", { headers: { "x-user-id": userId } });
    expectHit(t0Second, "second GET /v1/orders/my-orders (includeTracking omitted)", TTL.myOrders);

    // Variant t1 — a DIFFERENT key. Its first read must be a MISS even though t0
    // is now warm; a HIT here would mean the parameter is not part of the key.
    const t1First = await api.get("/v1/orders/my-orders?includeTracking=true", {
      headers: { "x-user-id": userId },
    });
    expect(t1First.status()).toBe(200);
    expectMiss(t1First, "first GET /v1/orders/my-orders?includeTracking=true (t0 is warm — this must still MISS)");
    const t1Second = await api.get("/v1/orders/my-orders?includeTracking=true", {
      headers: { "x-user-id": userId },
    });
    expectHit(t1Second, "second GET /v1/orders/my-orders?includeTracking=true", TTL.myOrders);

    // And the two entries really are different content, not merely different
    // keys — the `true` variant embeds tracking the `false` variant does not.
    expect(await t1Second.json()).not.toEqual(await t0Second.json());
  });

  test("POST /v1/orders invalidates BOTH my-orders variants", async () => {
    const api = await ordersClient();
    const userId = await registerCaller();
    const product = await firstProductWithStock(api, userId);

    // Warm both variants.
    expectMiss(
      await api.get("/v1/orders/my-orders", { headers: { "x-user-id": userId } }),
      "warm t0",
    );
    expectMiss(
      await api.get("/v1/orders/my-orders?includeTracking=true", { headers: { "x-user-id": userId } }),
      "warm t1",
    );

    const created = await api.post("/v1/orders", {
      headers: { "x-user-id": userId },
      data: { lines: [{ productId: product.id, quantity: 1 }] },
    });
    expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);
    const orderId = (await created.json()).id as string;

    // Both variants must be gone — the per-user key index is what makes deleting
    // a variable `t{0|1}` suffix possible without SCAN, and this is the assertion
    // that fails if only one of them was registered in that index.
    const t0 = await api.get("/v1/orders/my-orders", { headers: { "x-user-id": userId } });
    expectMiss(t0, "GET my-orders (t0) after POST /v1/orders");
    expect((await t0.json()).some((o: { id: string }) => o.id === orderId)).toBe(true);

    const t1 = await api.get("/v1/orders/my-orders?includeTracking=true", {
      headers: { "x-user-id": userId },
    });
    expectMiss(t1, "GET my-orders (t1) after POST /v1/orders");
  });
  ```

- [ ] **Step 9: Add the `GET /v1/orders/{orderId}` tests to `e2e/tests/cache.spec.ts`.**

  Append:

  ```ts
  test("GET /v1/orders/{orderId}: MISS then HIT, and the t0/t1 variants are separate keys", async () => {
    const api = await ordersClient();
    const userId = await registerCaller();
    const product = await firstProductWithStock(api, userId);
    const created = await api.post("/v1/orders", {
      headers: { "x-user-id": userId },
      data: { lines: [{ productId: product.id, quantity: 1 }] },
    });
    expect(created.status(), `order creation failed: ${await created.text()}`).toBe(201);
    const orderId = (await created.json()).id as string;

    const first = await api.get(`/v1/orders/${orderId}`, { headers: { "x-user-id": userId } });
    expect(first.status()).toBe(200);
    expectMiss(first, `first GET /v1/orders/${orderId}`);
    const second = await api.get(`/v1/orders/${orderId}`, { headers: { "x-user-id": userId } });
    expectHit(second, `second GET /v1/orders/${orderId}`, TTL.order);
    expect(await second.json()).toEqual(await first.json());

    // Same trap as my-orders: `?includeTracking=true` is key `...:t1`, a
    // different entry with a different body. Warm t0 must not satisfy it.
    const withTracking = await api.get(`/v1/orders/${orderId}?includeTracking=true`, {
      headers: { "x-user-id": userId },
    });
    expect(withTracking.status()).toBe(200);
    expectMiss(withTracking, `first GET /v1/orders/${orderId}?includeTracking=true (t0 is warm — this must still MISS)`);
  });

  test("GET /v1/orders/{orderId}: user B never gets a HIT on user A's warm order", async () => {
    const api = await ordersClient();
    const owner = await registerCaller();
    const other = await registerCaller();
    const product = await firstProductWithStock(api, owner);
    const created = await api.post("/v1/orders", {
      headers: { "x-user-id": owner },
      data: { lines: [{ productId: product.id, quantity: 1 }] },
    });
    expect(created.status()).toBe(201);
    const orderId = (await created.json()).id as string;

    expectMiss(await api.get(`/v1/orders/${orderId}`, { headers: { "x-user-id": owner } }), "owner first read");
    expectHit(await api.get(`/v1/orders/${orderId}`, { headers: { "x-user-id": owner } }), "owner second read", TTL.order);

    // The other caller must get the ownership 404, NOT a cached 200. Only 200s
    // are cached, so this also proves the non-200 exclusion holds.
    const asOther = await api.get(`/v1/orders/${orderId}`, { headers: { "x-user-id": other } });
    expect(asOther.status(), "another caller must never be served the owner's cached order").toBe(404);
  });
  ```

- [ ] **Step 10: Add the Tracking tests to `e2e/tests/cache.spec.ts`.**

  Append. Note the tracking rows are created directly through `init-tracking` with a synthetic
  order id, exactly as `e2e/tests/tracking.spec.ts` does, so these tests do not depend on Orders
  being up and do not wait for Orders' asynchronous `init-tracking` call.

  ```ts
  // A synthetic order id — deliberately NOT a real Orders order, matching
  // tests/tracking.spec.ts. `init-tracking` never validates the order's
  // existence, so this keeps the Tracking cache tests independent of Orders and
  // removes the "wait for the tracking row to appear" polling that would
  // otherwise sit between the setup and the MISS/HIT pair and burn TTL.
  // Fits VARCHAR(21) — ID_LENGTH in tracking's domain/models.py.
  function syntheticOrderId(): string {
    return `ord_c${Math.random().toString(36).slice(2, 12)}`.slice(0, 21);
  }

  async function createTracking(
    api: Awaited<ReturnType<typeof trackingClient>>,
    userId: string,
  ): Promise<string> {
    const orderId = syntheticOrderId();
    const res = await api.post("/v1/trackings/init-tracking", {
      headers: { "x-user-id": userId },
      // No `x-test-mode`: a tracking that advanced on its own would invalidate
      // its own cache mid-test and turn every HIT assertion racy.
      data: { order_id: orderId, shipping_address: { line1: "1 Test St", city: "Austin" } },
    });
    expect(res.status(), `init-tracking failed: ${await res.text()}`).toBe(201);
    return orderId;
  }

  test("GET /v1/trackings/{order_id}: MISS then HIT", async () => {
    const api = await trackingClient();
    const userId = await registerCaller();
    const orderId = await createTracking(api, userId);

    const first = await api.get(`/v1/trackings/${orderId}`, { headers: { "x-user-id": userId } });
    expect(first.status()).toBe(200);
    expectMiss(first, `first GET /v1/trackings/${orderId}`);
    const second = await api.get(`/v1/trackings/${orderId}`, { headers: { "x-user-id": userId } });
    expectHit(second, `second GET /v1/trackings/${orderId}`, TTL.tracking);
    expect(await second.json()).toEqual(await first.json());
  });

  test("the carrier PUT invalidates the tracking key: the next read is a MISS with the new status", async () => {
    const api = await trackingClient();
    const userId = await registerCaller();
    const orderId = await createTracking(api, userId);

    expectMiss(
      await api.get(`/v1/trackings/${orderId}`, { headers: { "x-user-id": userId } }),
      "first read",
    );
    expectHit(
      await api.get(`/v1/trackings/${orderId}`, { headers: { "x-user-id": userId } }),
      "second read",
      TTL.tracking,
    );

    // The carrier arrives with an API key and NO x-user-id — it does not know
    // the owner, so the invalidator must resolve `cognito_sub` from the tracking
    // row before deleting a key that carries `{sub}:{user_id}`. This assertion is
    // the one that fails if that resolution was skipped.
    const advanced = await api.put(`/v1/trackings/${orderId}/status`, {
      headers: carrierHeaders(),
      data: { status: "PROCESSING" },
    });
    expect(advanced.status(), `carrier PUT failed: ${await advanced.text()}`).toBe(200);

    const after = await api.get(`/v1/trackings/${orderId}`, { headers: { "x-user-id": userId } });
    expect(after.status()).toBe(200);
    expectMiss(after, "GET tracking after the carrier PUT");
    expect((await after.json()).status).toBe("PROCESSING");
  });

  test("GET /v1/trackings (batch): MISS then HIT for the same order_ids", async () => {
    const api = await trackingClient();
    const userId = await registerCaller();
    const orderId = await createTracking(api, userId);

    // The key is `tracking:list:v1:{sub}:{user_id}:{hash(order_ids)}` — the list
    // is normalized (sorted + deduped) then hashed, so the same set in a
    // different order is the SAME key. That property gets its own test below.
    const first = await api.get(`/v1/trackings?order_ids=${orderId}`, {
      headers: { "x-user-id": userId },
    });
    expect(first.status()).toBe(200);
    expectMiss(first, "first GET /v1/trackings (batch)");
    const second = await api.get(`/v1/trackings?order_ids=${orderId}`, {
      headers: { "x-user-id": userId },
    });
    expectHit(second, "second GET /v1/trackings (batch)", TTL.trackingList);
    expect(await second.json()).toEqual(await first.json());
  });

  test("GET /v1/trackings (batch): the order_ids list is normalized, so a reordered list HITs the same key", async () => {
    const api = await trackingClient();
    const userId = await registerCaller();
    const a = await createTracking(api, userId);
    const b = await createTracking(api, userId);

    expectMiss(
      await api.get(`/v1/trackings?order_ids=${a},${b}`, { headers: { "x-user-id": userId } }),
      "first batch read (a,b)",
    );
    // Reversed, and with a duplicate — normalization (sort + dedup) must fold
    // this onto the same key. A MISS here would mean the key is built from the
    // raw string, which multiplies cardinality by the number of orderings a
    // client happens to send.
    const reordered = await api.get(`/v1/trackings?order_ids=${b},${a},${b}`, {
      headers: { "x-user-id": userId },
    });
    expect(reordered.status()).toBe(200);
    expectHit(reordered, "reordered + deduplicated batch read", TTL.trackingList);
  });

  test("the carrier PUT invalidates the owner's batch list key too", async () => {
    const api = await trackingClient();
    const userId = await registerCaller();
    const orderId = await createTracking(api, userId);

    expectMiss(
      await api.get(`/v1/trackings?order_ids=${orderId}`, { headers: { "x-user-id": userId } }),
      "first batch read",
    );
    expectHit(
      await api.get(`/v1/trackings?order_ids=${orderId}`, { headers: { "x-user-id": userId } }),
      "second batch read",
      TTL.trackingList,
    );

    const advanced = await api.put(`/v1/trackings/${orderId}/status`, {
      headers: carrierHeaders(),
      data: { status: "SHIPPED" },
    });
    expect(advanced.status()).toBe(200);

    const after = await api.get(`/v1/trackings?order_ids=${orderId}`, {
      headers: { "x-user-id": userId },
    });
    expect(after.status()).toBe(200);
    expectMiss(after, "batch read after the carrier PUT");
    expect((await after.json())[0].status).toBe("SHIPPED");
  });
  ```

  > **Note:** the batch response shape is `GET /v1/trackings?order_ids=<csv>` per
  > `services/tracking/openapi.yaml:143-186`. If the 200 body is an envelope rather than a bare
  > array, adjust the last assertion to read through the envelope — check the schema referenced
  > at that line before running, and do not guess the field name.

- [ ] **Step 11: Add the `GET /v1/users/me` tests to `e2e/tests/cache.spec.ts`.**

  Append:

  ```ts
  test("GET /v1/users/me: MISS then HIT", async () => {
    const api = await apiClient();
    const userId = await registerCaller();

    const first = await api.get("/v1/users/me", { headers: { "x-user-id": userId } });
    expect(first.status()).toBe(200);
    expectMiss(first, "first GET /v1/users/me");
    const second = await api.get("/v1/users/me", { headers: { "x-user-id": userId } });
    expectHit(second, "second GET /v1/users/me", TTL.me);
    expect(await second.json()).toEqual(await first.json());
  });

  test("PATCH /v1/users/me invalidates the profile key: the next GET is a MISS with the new name", async () => {
    const api = await apiClient();
    const userId = await registerCaller();

    expectMiss(await api.get("/v1/users/me", { headers: { "x-user-id": userId } }), "first read");
    expectHit(await api.get("/v1/users/me", { headers: { "x-user-id": userId } }), "second read", TTL.me);

    const newFullName = "Cache Invalidation Test";
    const patch = await api.patch("/v1/users/me", {
      headers: { "x-user-id": userId },
      data: { fullName: newFullName },
    });
    expect(patch.status()).toBe(200);

    const after = await api.get("/v1/users/me", { headers: { "x-user-id": userId } });
    expect(after.status()).toBe(200);
    expectMiss(after, "GET /v1/users/me after PATCH");
    expect((await after.json()).fullName).toBe(newFullName);
  });

  test("PATCH /v1/users/me/password invalidates the profile key (mustChangePassword is in the body)", async () => {
    const api = await apiClient();
    const users = await apiClient();
    const user = makeUser();
    const registered = await users.post("/v1/users/register", { data: user });
    expect(registered.status()).toBe(201);
    const userId = (await registered.json()).id as string;

    expectMiss(await api.get("/v1/users/me", { headers: { "x-user-id": userId } }), "first read");
    expectHit(await api.get("/v1/users/me", { headers: { "x-user-id": userId } }), "second read", TTL.me);

    // The password change also mutates `mustChangePassword`, which is part of the
    // cached GET /v1/users/me body — so it must invalidate the profile key even
    // though nothing password-related is ever cached.
    const changed = await api.patch("/v1/users/me/password", {
      headers: { "x-user-id": userId },
      data: { newPassword: `Zz9!${user.password.slice(4)}` },
    });
    expect(changed.status(), `password change failed: ${await changed.text()}`).toBe(200);

    const after = await api.get("/v1/users/me", { headers: { "x-user-id": userId } });
    expect(after.status()).toBe(200);
    expectMiss(after, "GET /v1/users/me after PATCH /v1/users/me/password");
  });

  test("GET /v1/users/me: user B never gets a HIT on user A's warm profile", async () => {
    const api = await apiClient();
    const userA = await registerCaller();
    const userB = await registerCaller();

    expectMiss(await api.get("/v1/users/me", { headers: { "x-user-id": userA } }), "user A first read");
    expectHit(await api.get("/v1/users/me", { headers: { "x-user-id": userA } }), "user A second read", TTL.me);

    const asB = await api.get("/v1/users/me", { headers: { "x-user-id": userB } });
    expect(asB.status()).toBe(200);
    expectMiss(asB, "user B's first read must not hit user A's entry");
    expect((await asB.json()).id).toBe(userB);
  });

  // Non-200s are never cached (spec: "Only 200 responses populate the cache").
  // A 401 that ended up in Redis would be catastrophic — it would be served to
  // an authenticated caller — so this asserts the exclusion directly rather than
  // trusting it.
  test("a 401 is never cached: two unauthenticated reads both carry no HIT", async () => {
    const api = await apiClient();
    const first = await api.get("/v1/users/me");
    expect(first.status()).toBe(401);
    expect(first.headers()["x-cache"], "a 401 must never be served as a cache HIT").not.toBe("HIT");
    const second = await api.get("/v1/users/me");
    expect(second.status()).toBe(401);
    expect(second.headers()["x-cache"], "a 401 must never be served as a cache HIT").not.toBe("HIT");
  });
  ```

- [ ] **Step 12: Type-check the internal spec.**

  ```bash
  nvm use && pnpm --filter @3mrai/e2e typecheck
  ```

  Expected: exits 0, no output.

- [ ] **Step 13: Run the internal cache spec on its own and read every result.**

  ```bash
  nvm use && pnpm --filter @3mrai/e2e test -- --project=internal tests/cache.spec.ts
  ```

  Expected: every test in `tests/cache.spec.ts` passes, and the run reports
  `N passed` with zero failures. A `BYPASS` in a failure message means Redis is down (go back to
  Step 2); "no X-Cache header at all" means that service has `CACHE_ENABLED=false` or was not
  restarted after Task 1 (go back to Step 1).

  > **Note on ordering and `e2e-cleanup`.** `global-teardown.ts` calls
  > `DELETE /v1/trackings/e2e-cleanup`, `DELETE /v1/orders/e2e-cleanup` and
  > `DELETE /v1/users/e2e-cleanup` **once, after everything**, never between tests — so no test
  > in this file can observe a cache entry left warm for a row that cleanup has since deleted.
  > That ordering is what makes these specs safe, and it must not change. The hazard is real:
  > Orders' cleanup uses `ExecuteUpdateAsync`
  > (`services/orders/src/Orders.Api/Endpoints/E2eEndpoints.cs:40,50,74`), a set-based update
  > that bypasses the normal write path entirely — Task 3 wires cache invalidation into it for
  > exactly this reason. Tracking's cleanup does the same with bulk deletes. If a future change
  > moves cleanup into a `beforeEach`/`afterEach`, a HIT assertion here would start serving a
  > deleted row and the failure would look like a cache bug rather than a teardown bug.

- [ ] **Step 14: Create `e2e/tests/gateway/cache.spec.ts` with its header comment and helpers.**

  Write this preamble first.

  ```ts
  import { test, expect } from "@playwright/test";
  import { getGatewayToken } from "../../support/auth.js";
  import { gatewayClient } from "../../support/gateway-client.js";
  import { carrierHeaders } from "../../support/tracking-carrier-key.js";
  import { expectHit, expectMiss } from "../../support/cache-headers.js";

  // Gateway E2E for the response cache — real Cognito JWT through
  // API_GATEWAY_URL, the URL a person actually hits.
  //
  // ## This layer exists for exactly ONE reason
  //
  // An API Gateway, or an nginx `location` block, can silently STRIP a response
  // header it does not know about — and that failure is completely invisible from
  // the service port. The internal specs in tests/cache.spec.ts would stay green
  // while every real client received a response with no `X-Cache` at all, which
  // is indistinguishable from the cache being off. Nothing else in the suite can
  // see that, which is why this file duplicates the MISS/HIT shape rather than
  // being folded into the internal spec: the assertion is not "does the cache
  // work" — layer 2 answered that — it is "does the header SURVIVE the full
  // path". Required by docs/shared/conventions/testing.md and each service's
  // CLAUDE.md §2b.
  //
  // Every route these specs touch already has both its API Gateway route entry
  // (infra/modules/api-gateway/main.tf) and its nginx `location` block
  // (infra/modules/compute/nginx/nginx.conf: /v1/orders, /v1/products, /v1/cart,
  // /v1/trackings, and the default `/` for Users) — caching adds no new routes.
  // A 404 carrying the gateway's own `{"message":"Not Found"}` body rather than a
  // service's `{error: …}` shape would mean the request never reached nginx.
  //
  // ## All request paths are RELATIVE
  //
  // gatewayClient() normalizes baseURL to a trailing slash, and Playwright joins
  // with the WHATWG URL algorithm where a LEADING slash REPLACES the whole
  // baseURL path — dropping the request onto Floci's S3 root instead of the
  // gateway integration. See support/gateway-client.ts.
  //
  // ## Same TTL discipline as the internal spec
  //
  // MISS/HIT pairs are issued back to back with all setup done first, and there
  // is no waitForTimeout anywhere: the cart and tracking TTLs are 60 seconds, and
  // a sleep between the two reads is what turns a correct spec into an
  // intermittent one. This layer is SLOWER per request (JWT authorizer + nginx
  // hop), which makes the discipline matter more here, not less — so the coverage
  // is deliberately narrower than the internal spec's: one pair per endpoint,
  // plus the CACHE_ENABLED=false assertion. The exhaustive invalidation and
  // cross-user matrix stays in layer 2 where it is cheap.

  const TTL = {
    products: 600,
    cart: 60,
    myOrders: 120,
    order: 120,
    tracking: 60,
    trackingList: 60,
    me: 300,
  } as const;

  async function newAuthedClient(): Promise<Awaited<ReturnType<typeof gatewayClient>>> {
    const { token } = await getGatewayToken();
    return gatewayClient(token);
  }

  async function firstProductWithStock(
    api: Awaited<ReturnType<typeof gatewayClient>>,
  ): Promise<{ id: string; unitsInStock: number }> {
    const products = await api.get("v1/products");
    expect(products.status(), `GET v1/products failed: ${await products.text()}`).toBe(200);
    const product = (await products.json()).find((p: { unitsInStock: number }) => p.unitsInStock > 0);
    expect(product, "no product with stock in the catalogue").toBeTruthy();
    return product;
  }
  ```

- [ ] **Step 15: Add the Users and Orders gateway pairs to `e2e/tests/gateway/cache.spec.ts`.**

  Append:

  ```ts
  test("X-Cache survives the gateway on GET v1/users/me (nginx default `/` location)", async () => {
    const api = await newAuthedClient();

    const first = await api.get("v1/users/me");
    expect(first.status(), `GET v1/users/me failed: ${await first.text()}`).toBe(200);
    expectMiss(first, "first GET v1/users/me through the gateway");

    const second = await api.get("v1/users/me");
    expect(second.status()).toBe(200);
    // The whole point: HIT *and* X-Cache-TTL both arrived intact after the JWT
    // authorizer, njs sub-extraction and nginx's catch-all `location /` proxy.
    expectHit(second, "second GET v1/users/me through the gateway", TTL.me);
  });

  test("X-Cache survives the gateway on GET v1/products (nginx `location /v1/products`)", async () => {
    const api = await newAuthedClient();

    const first = await api.get("v1/products");
    expect(first.status()).toBe(200);
    // The catalogue key is shared and ownerless, so it may legitimately be warm
    // from an earlier test — the pair relationship is the assertion, not the
    // first read's value. It must still carry the header, and must not be BYPASS.
    expect(first.headers()["x-cache"]).toMatch(/^(MISS|HIT)$/);

    const second = await api.get("v1/products");
    expect(second.status()).toBe(200);
    expectHit(second, "second GET v1/products through the gateway", TTL.products);
  });

  test("X-Cache survives the gateway on GET v1/cart, and PUT v1/cart returns it to MISS", async () => {
    const api = await newAuthedClient();
    const product = await firstProductWithStock(api);

    const put = await api.put("v1/cart", { data: { items: [{ productId: product.id, quantity: 1 }] } });
    expect(put.status(), `PUT v1/cart failed: ${await put.text()}`).toBe(200);
    // A WRITE must never carry a cache header — only GETs are cached.
    expect(put.headers()["x-cache"], "PUT v1/cart must not carry X-Cache").toBeUndefined();

    const first = await api.get("v1/cart");
    expectMiss(first, "first GET v1/cart through the gateway");
    const second = await api.get("v1/cart");
    expectHit(second, "second GET v1/cart through the gateway", TTL.cart);

    const update = await api.put("v1/cart", { data: { items: [{ productId: product.id, quantity: 2 }] } });
    expect(update.status()).toBe(200);

    const after = await api.get("v1/cart");
    expectMiss(after, "GET v1/cart after PUT, through the gateway");
    expect((await after.json()).items[0].quantity).toBe(2);
  });

  test("X-Cache survives the gateway on both my-orders variants and on GET v1/orders/{orderId}", async () => {
    const api = await newAuthedClient();
    const product = await firstProductWithStock(api);
    const created = await api.post("v1/orders", { data: { lines: [{ productId: product.id, quantity: 1 }] } });
    expect(created.status(), `POST v1/orders failed: ${await created.text()}`).toBe(201);
    const orderId = (await created.json()).id as string;

    // t0.
    expectMiss(await api.get("v1/orders/my-orders"), "first GET v1/orders/my-orders (t0)");
    expectHit(await api.get("v1/orders/my-orders"), "second GET v1/orders/my-orders (t0)", TTL.myOrders);

    // t1 — a DIFFERENT key with a different body. Asserting a HIT here off the
    // warm t0 would be asserting a bug: it would only pass if the query
    // parameter were absent from the key.
    expectMiss(
      await api.get("v1/orders/my-orders?includeTracking=true"),
      "first GET v1/orders/my-orders?includeTracking=true (t0 is warm — this must still MISS)",
    );
    expectHit(
      await api.get("v1/orders/my-orders?includeTracking=true"),
      "second GET v1/orders/my-orders?includeTracking=true",
      TTL.myOrders,
    );

    // The param route — the one that historically dropped its path segment at
    // the gateway, so a header assertion on it is worth its own pair.
    expectMiss(await api.get(`v1/orders/${orderId}`), `first GET v1/orders/${orderId}`);
    expectHit(await api.get(`v1/orders/${orderId}`), `second GET v1/orders/${orderId}`, TTL.order);
  });
  ```

- [ ] **Step 16: Add the Tracking gateway pairs to `e2e/tests/gateway/cache.spec.ts`.**

  Append:

  ```ts
  // Tracking rows are created by ORDERS, asynchronously, after its transaction
  // commits — there is no gateway route to init-tracking for an end user. So this
  // test polls for the row FIRST (bounded, never unbounded), and only then issues
  // the MISS/HIT pair back to back. Polling before the pair rather than between
  // its two reads is the whole reason the 60s TTL cannot bite here.
  test("X-Cache survives the gateway on GET v1/trackings/{orderId} and on the batch read", async () => {
    const api = await newAuthedClient();
    const product = await firstProductWithStock(api);
    // No `x-test-mode`, so the tracking parks at PLACED and cannot advance —
    // and therefore cannot invalidate its own key — mid-test.
    const created = await api.post("v1/orders", { data: { lines: [{ productId: product.id, quantity: 1 }] } });
    expect(created.status(), `POST v1/orders failed: ${await created.text()}`).toBe(201);
    const orderId = (await created.json()).id as string;

    const deadline = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < deadline) {
      const probe = await api.get(`v1/trackings/${orderId}`);
      if (probe.status() === 200) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(
      ready,
      `No tracking appeared for ${orderId} within 20s — Orders' call to ` +
        "POST /v1/trackings/init-tracking did not land. Check the Orders logs.",
    ).toBe(true);

    // The poll above already warmed the key, so the pair is asserted as
    // HIT/HIT rather than MISS/HIT — pretending the first read is cold after
    // polling would be writing an assertion the test itself made false.
    const first = await api.get(`v1/trackings/${orderId}`);
    expect(first.status()).toBe(200);
    expectHit(first, `GET v1/trackings/${orderId} through the gateway`, TTL.tracking);

    // The batch key is a different key and has NOT been touched by the poll.
    expectMiss(await api.get(`v1/trackings?order_ids=${orderId}`), "first batch read through the gateway");
    expectHit(
      await api.get(`v1/trackings?order_ids=${orderId}`),
      "second batch read through the gateway",
      TTL.trackingList,
    );

    // The carrier route is declared `auth = false` at the gateway: no Bearer
    // token, only the API key. It must still invalidate through the full path.
    const carrier = await gatewayClient();
    const advanced = await carrier.put(`v1/trackings/${orderId}/status`, {
      headers: carrierHeaders(),
      data: { status: "PROCESSING" },
    });
    expect(advanced.status(), `carrier PUT failed: ${await advanced.text()}`).toBe(200);

    const after = await api.get(`v1/trackings/${orderId}`);
    expect(after.status()).toBe(200);
    expectMiss(after, "GET tracking after the carrier PUT, through the gateway");
    expect((await after.json()).status).toBe("PROCESSING");
  });
  ```

- [ ] **Step 17: Add the kill-switch gateway assertion to `e2e/tests/gateway/cache.spec.ts`.**

  This one is skipped by default and turned on only during the A/B run's OFF leg, because it
  asserts the opposite of every other test in the file.

  Append:

  ```ts
  // With CACHE_ENABLED=false there is NO X-Cache header at all — not MISS, not
  // BYPASS, nothing. That absence is worth its own gateway assertion for the same
  // reason the presence is: it is the observable difference between "the cache is
  // off" and "the gateway stripped the header", and confusing those two is
  // exactly the mistake this file exists to prevent.
  //
  // Guarded rather than skipped-by-default-forever: the ordinary suite runs with
  // caching ON, where this test would legitimately fail. The A/B load run's OFF
  // leg (see e2e/load-tests/README.md) is when it is meaningful, and
  // `E2E_EXPECT_CACHE_DISABLED=1` is how the operator says so.
  test("with CACHE_ENABLED=false the gateway returns NO X-Cache header at all", async () => {
    test.skip(
      process.env.E2E_EXPECT_CACHE_DISABLED !== "1",
      "Only meaningful while the services run with CACHE_ENABLED=false — set " +
        "E2E_EXPECT_CACHE_DISABLED=1 during the A/B run's OFF leg.",
    );
    const api = await newAuthedClient();

    const first = await api.get("v1/users/me");
    expect(first.status()).toBe(200);
    expect(first.headers()["x-cache"], "X-Cache must be absent when caching is off").toBeUndefined();

    const second = await api.get("v1/users/me");
    expect(second.status()).toBe(200);
    expect(second.headers()["x-cache"], "X-Cache must be absent when caching is off").toBeUndefined();
    expect(second.headers()["x-cache-ttl"]).toBeUndefined();
  });
  ```

- [ ] **Step 18: Type-check and run the gateway cache spec.**

  ```bash
  nvm use && pnpm --filter @3mrai/e2e typecheck && \
    pnpm --filter @3mrai/e2e test -- --project=gateway tests/gateway/cache.spec.ts
  ```

  Expected: typecheck exits 0; the gateway run reports every test passed with one skipped (the
  kill-switch test, whose skip reason names `E2E_EXPECT_CACHE_DISABLED`). If a test fails with
  *"expected X-Cache: MISS, got no X-Cache header at all"* while the same endpoint passes in
  `tests/cache.spec.ts`, that is **precisely the failure this layer exists to catch** — the
  gateway or nginx is stripping the header. Do not weaken the assertion; fix the proxy config.

- [ ] **Step 19: Create the load-test cache scenario at
      `e2e/load-tests/src/scenarios/cache.ts`.**

  ```ts
  import { exec } from "@gatling.io/core";
  import { http, header, status } from "@gatling.io/http";

  /**
   * Cache-focused read steps for the A/B simulation.
   *
   * Each cached endpoint is read TWICE per virtual user, under two DIFFERENT
   * request names — `(cold)` and `(warm)`. That split is the whole measurement:
   * Gatling reports percentiles per request name, so `(warm)` is the row that
   * carries the cache's actual effect, while a single averaged row would blend a
   * database read and a Redis read into one meaningless number.
   *
   * The X-Cache header is captured with `header("X-Cache")` — the SDK's header
   * check, applied as `.optional()` because on the CACHE_ENABLED=false leg of the
   * A/B there is no header at all and a required check would fail the entire run
   * for the condition being measured.
   *
   * ## Deliberately NO x-e2e-source and NO x-test-mode
   *
   * Per e2e/CLAUDE.md §4: this data persists like real data (nothing cleans it
   * up — reset with `make clean && make bootstrap`), and a tracking only advances
   * through the carrier webhook, the way a real carrier moves one.
   */

  const authHeader = (session: { get: (k: string) => unknown }) =>
    `Bearer ${session.get("token")}`;

  /**
   * Saves the X-Cache outcome into the session so the hit-rate can be tallied.
   *
   * `.optional()` matters twice over: on the OFF leg no header exists, and on the
   * ON leg a BYPASS is a legitimate (if unwanted) outcome. A required check would
   * turn either into a run-wide failure rather than a datum.
   */
  const captureCache = (attribute: string) =>
    header("X-Cache").optional().saveAs(attribute);

  /** The catalogue — the highest read/write ratio in the repo, 10-minute TTL. */
  export const readProductsCold = exec(
    http("GET /v1/products (cold)")
      .get("v1/products")
      .header("Authorization", authHeader)
      .check(status().is(200), captureCache("cacheProductsCold")),
  );

  export const readProductsWarm = exec(
    http("GET /v1/products (warm)")
      .get("v1/products")
      .header("Authorization", authHeader)
      .check(status().is(200), captureCache("cacheProductsWarm")),
  );

  /** The profile — 5-minute TTL, and the one Users endpoint that is cached. */
  export const readProfileCold = exec(
    http("GET /v1/users/me (cold)")
      .get("v1/users/me")
      .header("Authorization", authHeader)
      .check(status().is(200), captureCache("cacheMeCold")),
  );

  export const readProfileWarm = exec(
    http("GET /v1/users/me (warm)")
      .get("v1/users/me")
      .header("Authorization", authHeader)
      .check(status().is(200), captureCache("cacheMeWarm")),
  );

  /** The cart — 60s TTL, the busiest cart operation under real use. */
  export const readCartCold = exec(
    http("GET /v1/cart (cold)")
      .get("v1/cart")
      .header("Authorization", authHeader)
      .check(status().is(200), captureCache("cacheCartCold")),
  );

  export const readCartWarm = exec(
    http("GET /v1/cart (warm)")
      .get("v1/cart")
      .header("Authorization", authHeader)
      .check(status().is(200), captureCache("cacheCartWarm")),
  );

  /** my-orders, t0 — the default variant. */
  export const readMyOrdersCold = exec(
    http("GET /v1/orders/my-orders (cold)")
      .get("v1/orders/my-orders")
      .header("Authorization", authHeader)
      .check(status().is(200), captureCache("cacheMyOrdersCold")),
  );

  export const readMyOrdersWarm = exec(
    http("GET /v1/orders/my-orders (warm)")
      .get("v1/orders/my-orders")
      .header("Authorization", authHeader)
      .check(status().is(200), captureCache("cacheMyOrdersWarm")),
  );

  /**
   * my-orders, t1 — a SEPARATE cache key and a different body.
   *
   * Kept as its own request pair rather than folded into the t0 rows: it fans out
   * to Tracking's batch endpoint on a miss, so its cold cost is structurally
   * higher and averaging the two variants would understate exactly the saving
   * this simulation exists to measure.
   */
  export const readMyOrdersWithTrackingCold = exec(
    http("GET /v1/orders/my-orders?includeTracking=true (cold)")
      .get("v1/orders/my-orders")
      .queryParam("includeTracking", "true")
      .header("Authorization", authHeader)
      .check(status().is(200), captureCache("cacheMyOrdersTrackingCold")),
  );

  export const readMyOrdersWithTrackingWarm = exec(
    http("GET /v1/orders/my-orders?includeTracking=true (warm)")
      .get("v1/orders/my-orders")
      .queryParam("includeTracking", "true")
      .header("Authorization", authHeader)
      .check(status().is(200), captureCache("cacheMyOrdersTrackingWarm")),
  );

  /** One order by id — 2-minute TTL. Guarded by the caller: needs an orderId. */
  export const readOrderCold = exec(
    http("GET /v1/orders/{id} (cold)")
      .get((session) => `v1/orders/${session.get("orderId")}`)
      .header("Authorization", authHeader)
      .check(status().is(200), captureCache("cacheOrderCold")),
  );

  export const readOrderWarm = exec(
    http("GET /v1/orders/{id} (warm)")
      .get((session) => `v1/orders/${session.get("orderId")}`)
      .header("Authorization", authHeader)
      .check(status().is(200), captureCache("cacheOrderWarm")),
  );

  /**
   * One tracking by order id — 60s TTL, and the endpoint the identity cache
   * matters most for: without it, every read pays a gRPC call to Users before the
   * response key can even be built.
   *
   * Accepts 200 OR 404: Orders calls init-tracking asynchronously after its
   * transaction commits, so under load a read can legitimately arrive first.
   * Asserting 200 only would paint the run red for a race that is by design.
   */
  export const readTrackingCold = exec(
    http("GET /v1/trackings/{orderId} (cold)")
      .get((session) => `v1/trackings/${session.get("orderId")}`)
      .header("Authorization", authHeader)
      .check(status().in(200, 404), captureCache("cacheTrackingCold")),
  );

  export const readTrackingWarm = exec(
    http("GET /v1/trackings/{orderId} (warm)")
      .get((session) => `v1/trackings/${session.get("orderId")}`)
      .header("Authorization", authHeader)
      .check(status().in(200, 404), captureCache("cacheTrackingWarm")),
  );

  /** The batch read — 60s TTL, key is hash(sorted, deduped order_ids). */
  export const readTrackingsBatchCold = exec(
    http("GET /v1/trackings?order_ids= (cold)")
      .get("v1/trackings")
      .queryParam("order_ids", (session: { get: (k: string) => unknown }) => `${session.get("orderId")}`)
      .header("Authorization", authHeader)
      .check(status().is(200), captureCache("cacheTrackingsBatchCold")),
  );

  export const readTrackingsBatchWarm = exec(
    http("GET /v1/trackings?order_ids= (warm)")
      .get("v1/trackings")
      .queryParam("order_ids", (session: { get: (k: string) => unknown }) => `${session.get("orderId")}`)
      .header("Authorization", authHeader)
      .check(status().is(200), captureCache("cacheTrackingsBatchWarm")),
  );
  ```

- [ ] **Step 20: Verify `header(...)` really exists in the installed SDK before building the
      simulation on it.**

  Per the `gatling-js` skill: check the `.d.ts` files, never a Node import (the SDK's modules
  call `Java.type(...)` and only resolve inside Gatling's runtime).

  ```bash
  grep -rn "declare const header\|export declare function header\|\bheader\b" \
    e2e/load-tests/node_modules/@gatling.io/http/*.d.ts \
    e2e/load-tests/node_modules/@gatling.io/http/**/*.d.ts 2>/dev/null | grep -i "check\|HeaderCheck" | head
  ```

  Expected: at least one line declaring `header` as a check builder returning a
  `CheckBuilder`-family type. If it is absent from `@gatling.io/http`, grep
  `@gatling.io/core` instead — like `jsonPath`, some check builders live in core:

  ```bash
  grep -rn "\bheader\b" e2e/load-tests/node_modules/@gatling.io/core/*.d.ts | head
  ```

  Fix the import in `scenarios/cache.ts` to match whichever package declares it, and record
  which one in a `> **Note:**` comment in the file if it differs from `@gatling.io/http`.

- [ ] **Step 21: Create the A/B simulation at `e2e/load-tests/src/cacheAB.gatling.ts`.**

  ```ts
  import {
    simulation,
    scenario,
    exec,
    nothingFor,
    rampUsers,
    constantUsersPerSec,
    global,
    details,
    getParameter,
  } from "@gatling.io/core";
  import { http } from "@gatling.io/http";
  import { baseUrl, profile } from "./support/config.js";
  import { seedIdentity, register, login } from "./scenarios/users.js";
  import { listProducts, createOrder } from "./scenarios/orders.js";
  import { putCart } from "./scenarios/cart.js";
  import {
    readCartCold,
    readCartWarm,
    readMyOrdersCold,
    readMyOrdersWarm,
    readMyOrdersWithTrackingCold,
    readMyOrdersWithTrackingWarm,
    readOrderCold,
    readOrderWarm,
    readProductsCold,
    readProductsWarm,
    readProfileCold,
    readProfileWarm,
    readTrackingCold,
    readTrackingWarm,
    readTrackingsBatchCold,
    readTrackingsBatchWarm,
  } from "./scenarios/cache.js";

  /**
   * The cache A/B: the SAME traffic profile, run twice.
   *
   *   # leg A — caching on
   *   make load-test-cache-ab-on
   *   # leg B — caching off
   *   make load-test-cache-ab-off
   *
   * The comparison is made between the two HTML reports, per request name. This
   * simulation deliberately does NOT try to run both legs itself: `CACHE_ENABLED`
   * is a service-level environment variable read at process start, so flipping it
   * mid-run is impossible without restarting the services — and a restart inside a
   * measurement window would poison both halves of the result with cold pools and
   * an unwarmed JIT.
   *
   * ## What the request-name split buys
   *
   * Every cached endpoint appears as TWO rows, `(cold)` and `(warm)`. Gatling
   * reports p50/p95/p99 per request name, so the `(warm)` row IS the cached-read
   * latency and the `(cold)` row is the database read. On the OFF leg both rows
   * are database reads and should converge — that convergence is itself a check
   * that the A/B was actually performed rather than the same leg run twice.
   *
   * ## The identity-cache hit-rate is reported SEPARATELY, and that is mandatory
   *
   * `identity:sub-to-user:v1:{cognito_sub}` has a 1h TTL over an effectively
   * immutable mapping, so its hit-rate sits near 100%. Averaging it into the
   * response-cache hit-rates would drag every response prefix's number toward
   * 100% and make BOTH figures meaningless — the design spec says so explicitly.
   * It is therefore NOT visible in this simulation's own report at all (the
   * simulation only ever sees the response cache's X-Cache header): it is read
   * from OpenObserve, per KeyPrefix, using the query in
   * e2e/load-tests/README.md. Do not add an averaged "overall cache hit rate"
   * row here.
   *
   * ## No x-e2e-source, no x-test-mode
   *
   * Same as every other simulation here (e2e/CLAUDE.md §4): the data persists like
   * real data, and a tracking only moves through the carrier webhook. This
   * simulation does not drive deliveries at all — it measures reads.
   */
  export default simulation((setUp) => {
    // Recorded into the run so the two HTML reports are distinguishable at a
    // glance rather than by their timestamps. Set by the Makefile targets.
    const leg = getParameter("leg", "unspecified");

    const httpProtocol = http
      .baseUrl(baseUrl())
      .acceptHeader("application/json")
      .contentTypeHeader("application/json")
      .userAgentHeader("3mrai-load-tests/0.1");

    // One virtual user: sign up, create the state each cached read needs, then
    // read every cached endpoint twice. Setup is done ONCE, up front, so the
    // cold/warm pairs are adjacent — the 60s cart and tracking TTLs make that
    // ordering load-bearing here for the same reason it is in the E2E specs.
    const reader = scenario(`Cache reader (${leg})`)
      .exec(seedIdentity)
      .exec(register)
      .pause(1)
      .exec(login)
      .pause(1)
      .exec(listProducts)
      .exec(createOrder)
      .exec(putCart)
      .pause(1)
      // Users.
      .exec(readProfileCold)
      .exec(readProfileWarm)
      // Orders — catalogue and cart.
      .exec(readProductsCold)
      .exec(readProductsWarm)
      .exec(readCartCold)
      .exec(readCartWarm)
      // Orders — both my-orders variants, separate keys, separate rows.
      .exec(readMyOrdersCold)
      .exec(readMyOrdersWarm)
      .exec(readMyOrdersWithTrackingCold)
      .exec(readMyOrdersWithTrackingWarm)
      // Everything below needs an orderId. `createOrder` accepts 201 OR 409 —
      // order creation locks the product row FOR UPDATE, so concurrent buyers
      // genuinely contend — and a 409 saves no id. `!= null` (loose), NOT
      // `!== undefined`: Gatling's Session.get returns **null** for an unset
      // attribute, so a strict check never blocks and the guard is inert. That
      // exact bug shipped in fullJourney and sent hundreds of requests to
      // `/v1/orders/null`.
      .doIf((session) => session.get("orderId") != null)
      .then(
        exec(readOrderCold)
          .exec(readOrderWarm)
          .exec(readTrackingCold)
          .exec(readTrackingWarm)
          .exec(readTrackingsBatchCold)
          .exec(readTrackingsBatchWarm),
      );

    setUp(
      reader.injectOpen(
        // Let the stack settle so startup noise is not attributed to the run.
        nothingFor(5),
        // Warm-up: cold connection pools and an unwarmed JIT make the first
        // seconds unrepresentative — and in an A/B that noise lands unevenly
        // across the two legs, which is worse than it being merely inaccurate.
        rampUsers(profile.rampUsers).during(profile.rampDuration),
        constantUsersPerSec(profile.usersPerSec).during(profile.duration),
      ),
    )
      .protocols(httpProtocol)
      .assertions(
        // Deliberately LOOSE, and deliberately not a latency budget. This
        // simulation's job is to MEASURE a difference between two runs, not to
        // gate one of them: a p95 threshold tuned for the cached leg would fail
        // the uncached leg by design and destroy the comparison. The only
        // assertion is that the traffic was actually healthy enough for its
        // numbers to mean anything.
        global().successfulRequests().percent().gt(99),
        // details() takes a stats PATH — the request name alone, never the
        // scenario name. Passing the scenario fails every run with "Could not
        // find stats matching assertion path".
        details("GET /v1/users/me (warm)").responseTime().percentile3().lt(5000),
      );
  });
  ```

- [ ] **Step 22: Add the `cache-ab` script to `e2e/load-tests/package.json`.**

  Add to the `scripts` block, after `auth-codes`:

  ```json
  "cache-ab": "tsc --noEmit && gatling run --typescript --simulation cacheAB"
  ```

- [ ] **Step 23: Type-check the load-test package.**

  ```bash
  cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga/e2e/load-tests && nvm use && pnpm run check
  ```

  Expected: exits 0 with no output (`check` is `tsc --noEmit`). A `TS2305` on the `header`
  import means Step 20's grep pointed at the wrong package — fix the import, do not cast.

- [ ] **Step 24: Add the A/B Makefile targets.**

  Append to the `Makefile`, immediately after the existing `load-test-smoke` target (which ends
  at line 148):

  ```makefile
  cache-toggle: ## Flip CACHE_ENABLED in all three env files. Usage: make cache-toggle V=false
  	@# CACHE_ENABLED lives in the CUSTOM box of each generated env file, which
  	@# `make env-file` preserves verbatim — so this edit survives a regeneration.
  	@# Editing the AUTO box instead would be silently reverted on the next apply.
  	@test -n "$(V)" || { echo "Usage: make cache-toggle V=true|false"; exit 1; }
  	@for f in .env.local.orders .env.local.tracking .env.local.users; do \
  	  grep -q '^CACHE_ENABLED=' $$f || { echo "CACHE_ENABLED missing from $$f — is Task 1 merged?"; exit 1; }; \
  	  sed -i '' "s/^CACHE_ENABLED=.*/CACHE_ENABLED=$(V)/" $$f; \
  	  echo "$$f: $$(grep '^CACHE_ENABLED=' $$f)"; \
  	done
  	@# The flag is read at process start, so the services MUST be restarted for
  	@# it to take effect. `up -d` recreates only the containers whose env changed.
  	docker compose up -d --force-recreate users orders tracking
  	@echo "Waiting for the three services to answer their health checks..."
  	@until curl -sf http://localhost:3000/v1/health >/dev/null; do sleep 1; done
  	@until curl -sf http://localhost:3001/v1/health >/dev/null; do sleep 1; done
  	@until curl -sf http://localhost:3002/v1/health >/dev/null; do sleep 1; done
  	@echo "All three services healthy with CACHE_ENABLED=$(V)."

  load-test-cache-ab-on: ## A/B leg A — the cache simulation with CACHE_ENABLED=true.
  	$(MAKE) cache-toggle V=true
  	cd e2e/load-tests && \
  	  API_GATEWAY_URL="$$(grep '^API_GATEWAY_URL=' ../../.env.local.infra | cut -d= -f2-)" \
  	  TRACKING_CARRIER_API_KEY="$$(grep '^TRACKING_CARRIER_API_KEY=' ../../.env.local.tracking | cut -d= -f2-)" \
  	  pnpm run cache-ab leg=cache-on

  load-test-cache-ab-off: ## A/B leg B — the SAME simulation with CACHE_ENABLED=false.
  	$(MAKE) cache-toggle V=false
  	cd e2e/load-tests && \
  	  API_GATEWAY_URL="$$(grep '^API_GATEWAY_URL=' ../../.env.local.infra | cut -d= -f2-)" \
  	  TRACKING_CARRIER_API_KEY="$$(grep '^TRACKING_CARRIER_API_KEY=' ../../.env.local.tracking | cut -d= -f2-)" \
  	  pnpm run cache-ab leg=cache-off
  ```

  > **Note:** `sed -i ''` is the BSD/macOS spelling and is what the rest of this repo's tooling
  > assumes (`Platform: darwin`). On GNU sed it must be a bare `-i`. This is a documented Bash
  > limitation inside a Makefile recipe rather than a Python script only because Make recipes
  > are shell by definition — the repo's Python-first rule (`docs/shared/conventions/scripting-language.md`)
  > governs standalone scripts, and this is three lines of in-recipe glue, not a script.

- [ ] **Step 25: Verify the toggle actually flips and restarts, before spending a full load run
      on it.**

  ```bash
  cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga && \
    make cache-toggle V=false && \
    curl -sD - -o /dev/null http://localhost:3001/v1/products -H "x-user-id: nobody" | grep -i x-cache; echo "exit=$?"
  ```

  Expected: the target prints `CACHE_ENABLED=false` for all three files, recreates the three
  containers, reports all three healthy — and the grep finds **nothing** (`exit=1`), because with
  the cache off there is no `X-Cache` header at all. Then flip it back and confirm the header
  returns:

  ```bash
  make cache-toggle V=true && \
    curl -sD - -o /dev/null http://localhost:3001/v1/products -H "x-user-id: nobody" | grep -i x-cache
  ```

  Expected: one line, `x-cache: MISS` or `x-cache: HIT`. (A 401 body is fine and expected — the
  header assertion is about the response headers, and `/v1/products` requires a real caller;
  if the interceptor correctly skips non-200s, use a registered caller's id in place of
  `nobody` for the ON check.)

- [ ] **Step 26: Run the A/B — leg A, caching ON.**

  ```bash
  cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga && \
    make load-test-cache-ab-on
  ```

  Expected: the run completes with `Global: percentage of successful events is greater than 99
  : true`, and the CLI prints the HTML report path (`e2e/load-tests/target/gatling/cacheab-<ts>/index.html`).
  **Copy that path down** — the comparison in Step 28 needs both. Every cached endpoint should
  show two rows, `(cold)` and `(warm)`, with the warm p95 visibly below the cold one.

- [ ] **Step 27: Run the A/B — leg B, caching OFF, with the same profile.**

  ```bash
  cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga && \
    make load-test-cache-ab-off
  ```

  Expected: same success assertion, a second report path printed. On this leg the `(cold)` and
  `(warm)` rows for each endpoint should **converge** — both are database reads now. If they do
  not converge, either the flag did not take effect (re-check Step 25) or something other than
  the cache is making the second read faster (connection reuse, a warm DB buffer pool) — say so
  in the report rather than attributing it to the cache.

  > **Note:** run the two legs back to back on an otherwise idle machine, and do not run the
  > Playwright suite against the same stack in between. A load run leaves several hundred
  > `loadtest-*` events on the shared SQS queue, which the events-pipeline Lambda drains at
  > ~1 msg/s — every email-asserting E2E spec then times out at 45s and reads as a broken
  > pipeline (e2e/CLAUDE.md §4). It also means the OFF leg would be measuring a machine still
  > busy draining the ON leg's queue.

- [ ] **Step 28: Read the identity-cache hit-rate SEPARATELY from OpenObserve, and write the
      comparison into `e2e/load-tests/README.md`.**

  The response-cache hit-rate per endpoint comes from the two Gatling reports (the `(warm)`
  rows). The identity-cache hit-rate does not appear there at all — the simulation never sees
  it, because it lives behind the response cache. Read it from the `cache_requests_total`
  metric, filtered to its own `KeyPrefix`:

  ```
  KeyPrefix = 'identity:sub-to-user:v1'   →  hit / (hit + miss),  bypass EXCLUDED
  ```

  and the response-cache prefixes separately, one row each:

  ```
  orders:products:v1 · orders:cart:v1 · orders:my-orders:v1 · orders:order:v1
  tracking:order:v1 · tracking:list:v1 · users:me:v1
  ```

  Add a `## The cache A/B` section to `e2e/load-tests/README.md` containing: the two commands
  from Steps 26-27, a table with one row per endpoint and columns `p50 / p95 / p99 (cache on)`,
  `p50 / p95 / p99 (cache off)`, `hit-rate`, and — **below that table, never inside it** — a
  separate one-line figure for the identity cache. State the reason in the README itself, in
  one sentence: the identity cache's 1h TTL over an effectively immutable mapping puts its
  hit-rate near 100%, so averaging it into the response-cache figures drags every one of them
  toward 100% and makes both numbers meaningless.

- [ ] **Step 29: Add the `cache-ab` script to `e2e/CLAUDE.md` §2.**

  In the **Gatling** bullet list, change:

  ```
  - `pnpm run smoke` (~30s sanity) · `pnpm run load` · `pnpm run users` ·
    `pnpm run auth-codes`
  ```

  to:

  ```
  - `pnpm run smoke` (~30s sanity) · `pnpm run load` · `pnpm run users` ·
    `pnpm run auth-codes` · `pnpm run cache-ab` (the cache A/B; drive it via
    `make load-test-cache-ab-on` / `-off`, which flip `CACHE_ENABLED` and restart
    the services for you)
  ```

- [ ] **Step 30: Restore the flag to its default before finishing.**

  ```bash
  cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga && \
    make cache-toggle V=true && grep -h '^CACHE_ENABLED=' .env.local.orders .env.local.tracking .env.local.users
  ```

  Expected: three lines, all `CACHE_ENABLED=true`, and the three services healthy. Leaving the
  repo with the cache off would silently make every assertion in `tests/cache.spec.ts` and
  `tests/gateway/cache.spec.ts` fail for the next person with *"no X-Cache header at all"*.

- [ ] **Step 31: Run the FULL E2E suite — both Playwright projects — and confirm it is green.**

  ```bash
  cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga && \
    nvm use && pnpm --filter @3mrai/e2e typecheck && pnpm --filter @3mrai/e2e test
  ```

  Expected: typecheck exits 0; the Playwright run executes the `internal`, `gateway` and
  `observability` projects and reports `N passed` with **zero failed**. One skip is expected and
  correct — the `CACHE_ENABLED=false` gateway test, which names `E2E_EXPECT_CACHE_DISABLED` as
  its reason. The `observability` project may skip with its own named reason if
  `make observability-up` is not running; that is a prerequisite state, not a failure.

  If `global-setup` prints the events-queue backlog warning, the two load-test legs from Steps
  26-27 left several hundred messages on the shared queue and every email-asserting spec in the
  suite will time out at 45s for a reason unrelated to this task. Wait for the queue to drain
  (~1 msg/s) or reset with `make clean && make bootstrap` before reading the result as a
  verdict on the cache work.

- [ ] **Step 32: Final verification — the three-layer completeness check for every cached
      endpoint.**

  Confirm each of the seven cached endpoints has all three layers, and say so explicitly rather
  than assuming it. Layer 1 came from Tasks 2-5; layers 2 and 3 are this task's:

  ```bash
  cd /Users/josemartinez/orca/workspaces/3-microservices-running-on-aws-infrastructure/beluga && \
    grep -c '^test(' e2e/tests/cache.spec.ts e2e/tests/gateway/cache.spec.ts
  ```

  Expected: `e2e/tests/cache.spec.ts` reports at least 17 tests and
  `e2e/tests/gateway/cache.spec.ts` at least 6. Then check by hand that every one of
  `GET /v1/products`, `GET /v1/cart`, `GET /v1/orders/my-orders` (both `includeTracking`
  variants), `GET /v1/orders/{orderId}`, `GET /v1/trackings`, `GET /v1/trackings/{order_id}` and
  `GET /v1/users/me` appears in **both** files. An endpoint present in only one of them is an
  incomplete change per `docs/shared/conventions/testing.md`, regardless of how green the run is.

---

## Related

- [[2026-08-25-response-caching-layer-design]]
- [[x-cache-response-header]]
- [[logging-context]]
- [[current-caller-context]]
- [[testing]]
- [[env-files]]
- [[orders-service-design]]
- [[tracking-service-design]]
- [[users-service-design]]
