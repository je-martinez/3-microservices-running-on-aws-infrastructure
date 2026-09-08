using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;
using Orders.Application.Carts;
using Orders.Application.Identity;
using Orders.Domain.Entities;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence.Configurations;
using Orders.Infrastructure.Persistence;

namespace Orders.Infrastructure.Carts;

/// <summary>
/// Every write to a cart. Mirrors CreateOrderService: transactional, run under an
/// AmbientActor so the audit columns say what produced the row.
/// </summary>
public class CartWriteService
{
    /// <summary>
    /// The binary collation pinned on every ownership comparison in the account-erasure
    /// cascade — here and in <c>InternalEndpoints</c>.
    /// CONTRACT: Reference this constant, never a repeated literal. A drifted spelling
    /// silently stops collating at the site that missed it — the query still runs, just
    /// case-insensitively. See [[soft-delete]]
    /// </summary>
    public const string BinaryCollation = "utf8mb4_bin";

    private readonly OrdersWriteDbContext _db;
    private readonly IUserDirectory _users;
    private readonly CartReadService _reads;
    private readonly IWorkflowTracer _tracer;
    private readonly ICacheInvalidator _cache;
    private readonly ILogger<CartWriteService> _logger;

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

    /// <summary>
    /// Replaces the caller's cart lines with exactly <paramref name="command"/>. FULL
    /// REPLACEMENT: a product absent from the command is removed, quantity 0 removes it
    /// too, and if nothing live remains the cart itself is deleted.
    /// </summary>
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

                // CONTRACT: Invalidate AFTER the commit, never before — a concurrent read in
                // the gap repopulates the stale cart for a full TTL. Keep it here rather than
                // at any single commit site: ReplaceInternalAsync commits in three places, and
                // this covers all of them plus any added later. Not in a finally — a throw
                // means nothing committed. See [[x-cache-response-header]]
                await _cache.InvalidateCartAsync(cognitoSub, ct);

                return cart;
            });

    private async Task<CartDto> ReplaceInternalAsync(
        UpdateCartCommand command,
        string cognitoSub,
        CancellationToken ct)
    {
        _logger.LogInformation(
            "Starting cart update {app_event} {line_count}",
            "update_cart_started", command.Items.Count);

        // WHY: Zero means "remove", dropped once here so everything downstream deals only
        // in live lines.
        var wanted = command.Items.Where(i => i.Quantity > 0).ToList();

        // CONTRACT: Resolve identity only when there are lines to persist. Resolving before
        // the filter makes `PUT {"items": []}` answer 404 unknown_user where DELETE /v1/cart
        // answers 204 for the same caller, and makes emptying a cart depend on Users being
        // reachable. Id-only: this path never needs the caller's PII.
        // See [[orders-service-design]]
        string? userId = null;
        if (wanted.Count > 0)
        {
            userId = await _users.ResolveInternalUserIdAsync(cognitoSub, ct);
            if (userId is null)
            {
                _logger.LogError(
                    "Cart update failed: the caller is not a known user {app_event} {reason}",
                    "update_cart_failed", "unknown_user");
                _tracer.SetReason("unknown_user");
                throw new UnknownUserException(cognitoSub);
            }
        }

        return await AmbientActor.RunAsync(AuditActor.UpdateCart, async () =>
        {
            await using var tx = await _db.Database.BeginTransactionAsync(ct);

            var cart = await _db.Carts
                .Include(c => c.Items)
                .FirstOrDefaultAsync(c => c.CognitoSub == cognitoSub, ct);

            // WHY: A cart with no live lines does not exist.
            if (wanted.Count == 0)
            {
                if (cart is not null)
                {
                    SoftDelete(cart);
                }

                await _db.SaveChangesAsync(ct);
                await tx.CommitAsync(ct);

                _logger.LogInformation(
                    "Cart update emptied and removed the cart {app_event}", "update_cart_succeeded");

                return await _reads.BuildAsync(null, ct);
            }

            if (cart is null)
            {
                cart = new Cart
                {
                    Id = NanoId.NewId(NanoId.CartPrefix),
                    // WHY: Non-null — userId is resolved above whenever wanted.Count > 0.
                    UserId = userId!,
                    CognitoSub = cognitoSub,
                };
                _db.Carts.Add(cart);
            }

            SyncLines(cart, wanted);

            try
            {
                await _db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException ex) when (IsActiveCartUniqueViolation(ex))
            {
                // CONTRACT: Two concurrent PUTs from a user with no cart both insert and
                // uq_cart_active_user_id stops the loser; do NOT let that surface as a 500.
                // Retry exactly ONCE, adopting the winner — a second failure is not this race.
                _logger.LogInformation(
                    "Concurrent cart creation lost the race; retrying against the winner {app_event} {reason}",
                    "update_cart_retried", "active_cart_exists");

                await tx.RollbackAsync(ct);

                await using var retryTx = await _db.Database.BeginTransactionAsync(ct);

                var winner = await _db.Carts
                    .Include(c => c.Items)
                    .FirstOrDefaultAsync(c => c.CognitoSub == cognitoSub, ct)
                    // WHY: The winner was deleted in between; surface the original exception
                    // rather than inventing a state.
                    ?? throw ex;

                SyncLines(winner, wanted);

                await _db.SaveChangesAsync(ct);
                await retryTx.CommitAsync(ct);

                _logger.LogInformation(
                    "Cart updated {app_event} {line_count}", "update_cart_succeeded", wanted.Count);

                return await _reads.BuildAsync(winner, ct);
            }

            await tx.CommitAsync(ct);

            _logger.LogInformation(
                "Cart updated {app_event} {line_count}", "update_cart_succeeded", wanted.Count);

            return await _reads.BuildAsync(cart, ct);
        });
    }

    /// <summary>
    /// True when this failure is the one-active-cart index rejecting a concurrent insert.
    /// CONTRACT: Match the index NAME, never the MySQL error number alone. `cart_item` has
    /// its own unique index, and retrying that violation (the same product twice in one
    /// cart) papers over a real bug. See [[orders-service-design]]
    /// </summary>
    private static bool IsActiveCartUniqueViolation(DbUpdateException ex) =>
        ex.InnerException?.Message.Contains(
            CartConfiguration.ActiveUserIdIndexName, StringComparison.OrdinalIgnoreCase) == true;

    /// <summary>Deletes the caller's active cart. Idempotent.</summary>
    public async Task DeleteAsync(string cognitoSub, CancellationToken ct = default)
    {
        // WHY: Traced with a _started/_succeeded pair, unlike a read — this destroys the
        // user's selection, and the save is an intermediate step at which _started can be
        // the last line seen. See [[logging-context]]
        await _tracer.TraceWorkflowAsync(
            "delete_cart",
            new Dictionary<string, object?> { ["app_event"] = "delete_cart_started" },
            async () =>
            {
                _logger.LogInformation("Starting cart deletion {app_event}", "delete_cart_started");

                await AmbientActor.RunAsync(AuditActor.DeleteCart, async () =>
                {
                    await DeleteForUserAsync(_db, cognitoSub, ct);
                    await _db.SaveChangesAsync(ct);
                    return true;
                });

                // CONTRACT: Invalidate after the save, which is the commit on this path — a
                // concurrent read in the gap repopulates the deleted cart for a full TTL.
                await _cache.InvalidateCartAsync(cognitoSub, ct);

                // WHY: No _failed branch — a DB fault throws out of TraceWorkflowAsync, which
                // records it. Says nothing about whether a cart existed: DELETE is idempotent,
                // so "deleted nothing" is a success. See [[logging-context]]
                _logger.LogInformation("Cart deleted {app_event}", "delete_cart_succeeded");

                return true;
            });
    }

    /// <summary>
    /// Soft-deletes a user's active cart and its lines on the GIVEN context, without saving.
    /// CONTRACT: Match on <c>cognito_sub</c> ALONE. Also matching <c>user_id</c> lets a
    /// checkout destroy a stale row sharing the internal id under an older sub, losing
    /// someone's selection mid-checkout. Erasure uses the overload below. The caller owns
    /// SaveChanges, which is what lets order creation delete the cart in its own
    /// transaction. See [[soft-delete]]
    /// </summary>
    public static async Task DeleteForUserAsync(
        OrdersWriteDbContext db,
        string cognitoSub,
        CancellationToken ct = default)
    {
        var cart = await db.Carts
            .Include(c => c.Items)
            .FirstOrDefaultAsync(c => c.CognitoSub == cognitoSub, ct);

        if (cart is not null)
        {
            SoftDelete(cart);
        }
    }

    /// <summary>
    /// Soft-deletes EVERY cart matching <c>cognito_sub</c> OR <c>user_id</c>, for the
    /// account-erasure cascade. Does not save.
    /// CONTRACT: Both arguments MUST be non-empty (the caller validates) — the columns are
    /// <c>NOT NULL varchar</c>, which permits the empty string, so an empty value matches
    /// every blank row. Keep both comparisons pinned to <see cref="BinaryCollation"/>: the
    /// columns are case-insensitive while the ids are mixed-case, so an erasure would delete
    /// a DIFFERENT user's cart differing only in capitalization. See [[soft-delete]]
    /// </summary>
    public static async Task DeleteForUserAsync(
        OrdersWriteDbContext db,
        string cognitoSub,
        string userId,
        CancellationToken ct = default)
    {
        var carts = await db.Carts
            .Include(c => c.Items)
            .Where(c => EF.Functions.Collate(c.CognitoSub, BinaryCollation)
                    == EF.Functions.Collate(cognitoSub, BinaryCollation)
                || EF.Functions.Collate(c.UserId, BinaryCollation)
                    == EF.Functions.Collate(userId, BinaryCollation))
            .ToListAsync(ct);

        foreach (var cart in carts)
        {
            SoftDelete(cart);
        }
    }

    private static void SoftDelete(Cart cart)
    {
        var now = DateTime.UtcNow;
        cart.DeletedAt = now;

        // CONTRACT: Soft-delete the lines too. Live lines keep the cart_item unique index
        // occupied, so the user's next cart cannot hold the same product.
        foreach (var item in cart.Items)
        {
            item.DeletedAt = now;
        }
    }

    private static void SyncLines(Cart cart, IReadOnlyList<CartLineInput> wanted)
    {
        var now = DateTime.UtcNow;
        var wantedById = wanted.ToDictionary(i => i.ProductId, i => i.Quantity);

        // WHY: Replacement semantics — absence from the command IS the removal instruction.
        foreach (var existing in cart.Items.Where(i => !wantedById.ContainsKey(i.ProductId)))
        {
            existing.DeletedAt = now;
        }

        foreach (var (productId, quantity) in wantedById)
        {
            // CONTRACT: Keep `&& !i.IsDeleted`. The loop above may have just set DeletedAt on
            // a line in this same collection; without it, that row is updated with DeletedAt
            // still set — a line updated and invisible at once, so the product goes silently
            // missing from the cart the caller just asked for.
            var existing = cart.Items.FirstOrDefault(i => i.ProductId == productId && !i.IsDeleted);
            if (existing is null)
            {
                cart.Items.Add(new CartItem
                {
                    Id = NanoId.NewId(NanoId.CartItemPrefix),
                    CartId = cart.Id,
                    ProductId = productId,
                    Quantity = quantity,
                });
            }
            else
            {
                existing.Quantity = quantity;
            }
        }
    }
}
