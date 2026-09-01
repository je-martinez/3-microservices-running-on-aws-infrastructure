namespace Orders.Infrastructure.Caching;

/// <summary>
/// Every cache key this service uses, built in one place.
/// </summary>
/// <remarks>
/// Centralizing key construction is what makes cross-user leakage structurally impossible:
/// no caller ever concatenates a key by hand, so no caller can forget the
/// <c>cognito_sub</c>/<c>user_id</c> segments that scope a per-user entry to its owner.
/// </remarks>
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

    /// <summary>
    /// The catalogue: one key for everyone, and the only response key in this service
    /// with neither a <c>cognito_sub</c> nor a <c>user_id</c> segment. Products belong to
    /// no user.
    /// </summary>
    public static string Products => ProductsPrefix;

    public static string Cart(string sub, string userId) => $"{CartPrefix}:{sub}:{userId}";

    public static string MyOrders(string sub, string userId, bool includeTracking) =>
        $"{MyOrdersPrefix}:{sub}:{userId}:t{(includeTracking ? 1 : 0)}";

    public static string Order(string sub, string userId, string orderId, bool includeTracking) =>
        $"{OrderPrefix}:{sub}:{userId}:{orderId}:t{(includeTracking ? 1 : 0)}";

    public static string Identity(string sub) => $"{IdentityPrefix}:{sub}";

    public static string UserIndex(string sub) => $"{UserIndexPrefix}:{sub}";

    /// <summary>
    /// The leading three colon-separated segments of <paramref name="key"/> — its family.
    /// </summary>
    /// <remarks>
    /// The prefix is the ONLY part of a key that may reach a span attribute or a metric
    /// dimension: the rest carries <c>cognito_sub</c> and <c>user_id</c>, and unbounded
    /// dimension values would also explode CloudWatch cardinality and cost.
    /// </remarks>
    public static string PrefixOf(string key)
    {
        var parts = key.Split(':');
        return parts.Length >= 3 ? string.Join(':', parts[0], parts[1], parts[2]) : key;
    }
}
