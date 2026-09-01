namespace Orders.Infrastructure.Caching;

/// <summary>
/// Write-path cache invalidation, named by the business event that makes entries stale.
/// </summary>
/// <remarks>
/// WHY: Named by event, not key list — keeps invalidation knowledge in one implementation.
/// CONTRACT: Implementations MUST NOT throw — call sites run after commit; a throw turns a
/// persisted write into an error response.
/// See [[x-cache-response-header]]
/// </remarks>
public interface ICacheInvalidator
{
    /// <summary>Forgets the caller's cart entry. For PUT and DELETE /v1/cart.</summary>
    Task InvalidateCartAsync(string cognitoSub, CancellationToken ct);

    /// <summary>Forgets cart, my-orders (t0/t1), and product catalogue after order creation.</summary>
    Task InvalidateOrderCreationAsync(string cognitoSub, CancellationToken ct);

    /// <summary>Forgets the shared product catalogue entry. For the E2E restock.</summary>
    Task InvalidateProductsAsync(CancellationToken ct);

    /// <summary>
    /// Forgets every response and identity entry for a deleted user (DELETE /v1/orders/by-user).
    /// CONTRACT: Pass BOTH cognitoSub and userId — keys use whichever id the client sent in x-user-id;
    /// sweeping the sub alone replays erased orders from cache (X-Cache: HIT) for up to 2 minutes.
    /// See [[x-cache-response-header]]
    /// </summary>
    Task InvalidateDeletedUserAsync(string cognitoSub, string? userId, CancellationToken ct);
}
