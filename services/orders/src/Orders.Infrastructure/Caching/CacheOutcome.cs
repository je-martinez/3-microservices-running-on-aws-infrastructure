namespace Orders.Infrastructure.Caching;

/// <summary>
/// The outcome of a cache lookup, as reported on the <c>X-Cache</c> response header.
/// CONTRACT: Keep <see cref="Bypass"/> (Redis unavailable) distinct from <see cref="Miss"/>
/// (Redis answered "not there") — collapsed, a Redis outage reads as a poor hit rate rather
/// than as an outage. See [[x-cache-response-header]]
/// </summary>
public enum CacheResult
{
    Hit,
    Miss,
    Bypass,
}

/// <summary>
/// A cache lookup's result plus, on a hit, the value and the seconds left on its TTL. A
/// record STRUCT because it is allocated on every cached read and never stored.
/// <see cref="TtlRemainingSeconds"/> is 0 for anything but a hit, matching the
/// <c>X-Cache-TTL</c> header, which is only emitted on a hit.
/// </summary>
public readonly record struct CacheOutcome<T>(CacheResult Result, T? Value, int TtlRemainingSeconds)
{
    public static CacheOutcome<T> Miss() => new(CacheResult.Miss, default, 0);

    public static CacheOutcome<T> Bypass() => new(CacheResult.Bypass, default, 0);

    public static CacheOutcome<T> Hit(T value, int ttlRemaining) =>
        new(CacheResult.Hit, value, ttlRemaining);
}
