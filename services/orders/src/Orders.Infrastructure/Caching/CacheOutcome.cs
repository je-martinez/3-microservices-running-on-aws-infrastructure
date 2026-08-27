namespace Orders.Infrastructure.Caching;

/// <summary>
/// The outcome of a cache lookup, as reported on the <c>X-Cache</c> response header.
/// </summary>
/// <remarks>
/// Three-valued deliberately: <see cref="Bypass"/> (Redis unavailable) is NOT
/// <see cref="Miss"/> (Redis answered "not there"). Collapsing them would make a Redis
/// outage read as a poor hit-rate in the metrics instead of as an outage — the two have
/// completely different remedies, and only one of them is a caching problem.
/// </remarks>
public enum CacheResult
{
    Hit,
    Miss,
    Bypass,
}

/// <summary>
/// A cache lookup's result plus, on a hit, the value and the seconds left on its TTL.
/// </summary>
/// <remarks>
/// A record STRUCT rather than a class: this is allocated on every cached read, carries no
/// identity of its own, and is never stored. <see cref="TtlRemainingSeconds"/> is 0 for
/// anything but a hit — it is the value the <c>X-Cache-TTL</c> header reports, and that
/// header is only emitted on a hit.
/// </remarks>
public readonly record struct CacheOutcome<T>(CacheResult Result, T? Value, int TtlRemainingSeconds)
{
    public static CacheOutcome<T> Miss() => new(CacheResult.Miss, default, 0);

    public static CacheOutcome<T> Bypass() => new(CacheResult.Bypass, default, 0);

    public static CacheOutcome<T> Hit(T value, int ttlRemaining) =>
        new(CacheResult.Hit, value, ttlRemaining);
}
