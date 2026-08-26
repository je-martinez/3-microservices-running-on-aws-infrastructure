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
    /// Replaces the caller's cart lines with exactly <paramref name="command"/>.
    /// </summary>
    /// <remarks>
    /// FULL REPLACEMENT: a product absent from the command is removed, and a product
    /// sent at quantity 0 is removed too (deliberately redundant, so the frontend may
    /// send its list pre-filtered or not). If nothing live remains afterwards the cart
    /// itself is deleted — see <see cref="DeleteForUserAsync"/> for why that is one
    /// path rather than three branches.
    /// </remarks>
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
                // concurrent read repopulate the stale value in the window between the
                // delete and the commit landing.
                //
                // THIS is the seam, and it is the only one that works.
                // ReplaceInternalAsync commits in THREE places: the emptied branch, the
                // unique-index race retry, and the normal path. Putting the call after any
                // one of them covers one third of the writes; putting it here, after the
                // method returns, covers all three by construction — including a fourth
                // commit site somebody adds later.
                //
                // It is deliberately NOT inside a finally: a throw means no commit
                // happened (every path rolls back), so there is nothing stale to forget.
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

        // Zero means "remove", so it is dropped here, once, before any persistence
        // logic runs. Everything downstream then deals only in live lines.
        var wanted = command.Items.Where(i => i.Quantity > 0).ToList();

        // Identity is resolved ONLY when there are lines to persist, because the usr_ id
        // is needed for exactly one thing: stamping it onto a cart being CREATED.
        //
        // Ordering this after the filter is what makes an emptying PUT agree with
        // DELETE /v1/cart. Both are specified to reach the same state — no cart — and
        // DELETE has never needed identity, so resolving first made `PUT {"items": []}`
        // answer 404 unknown_user where DELETE answers 204 for the very same caller. It
        // also made emptying a cart depend on Users being reachable to do something that
        // never touches Users.
        //
        // Id-only resolution: this path never needs the caller's PII (email, name,
        // address). See IUserDirectory's doc comment for why the two methods exist.
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

            // Nothing left to hold: a cart with no live lines does not exist.
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
                    // Non-null here: userId is resolved above whenever wanted.Count > 0,
                    // and this branch only runs in that case.
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
                // Two concurrent PUTs from a user with no cart: both read null above and
                // both insert, and uq_cart_active_user_id stops the loser. That index is
                // the whole reason the invariant holds (a C# "does one exist?" check
                // would race), so hitting it is expected under concurrency rather than
                // exceptional — and the caller should not see a 500 for something the
                // system handled correctly.
                //
                // Retry ONCE by adopting the cart that won: this request wanted a cart
                // for this user, and now there is one. Retrying more than once would be
                // wrong — a second failure means something other than this race.
                _logger.LogInformation(
                    "Concurrent cart creation lost the race; retrying against the winner {app_event} {reason}",
                    "update_cart_retried", "active_cart_exists");

                await tx.RollbackAsync(ct);

                await using var retryTx = await _db.Database.BeginTransactionAsync(ct);

                var winner = await _db.Carts
                    .Include(c => c.Items)
                    .FirstOrDefaultAsync(c => c.CognitoSub == cognitoSub, ct)
                    // If it is gone, the winner was deleted between the violation and
                    // this read. Nothing sensible left to adopt, so let the original
                    // exception surface rather than inventing a state.
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
    /// </summary>
    /// <remarks>
    /// Matched on the index NAME, not on the error number alone: `cart_item` carries its
    /// own unique index, and a violation there means something quite different (the same
    /// product twice in one cart) that a retry would not fix. Treating every duplicate-key
    /// failure as this race would silently paper over that.
    /// </remarks>
    private static bool IsActiveCartUniqueViolation(DbUpdateException ex) =>
        ex.InnerException?.Message.Contains(
            CartConfiguration.ActiveUserIdIndexName, StringComparison.OrdinalIgnoreCase) == true;

    /// <summary>Deletes the caller's active cart. Idempotent.</summary>
    public async Task DeleteAsync(string cognitoSub, CancellationToken ct = default)
    {
        // Traced and logged unlike a plain read: this DESTROYS the user's selection.
        // When someone asks "where did my cart go?", these are the only lines that can
        // answer it — the deletion is a soft-delete, so the row survives, but nothing
        // else records that the user asked for it rather than an order consuming it.
        //
        // A _started/_succeeded pair here, not the single line a read gets: the write
        // has an intermediate step (the soft-delete before SaveChanges) at which
        // _started could genuinely be the last line seen if the save faults.
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

                // After the save, for the same reason ReplaceAsync invalidates after its
                // commit. There is no explicit transaction on this path — SaveChangesAsync
                // above IS the commit — so this is the first moment the deletion is
                // durable.
                await _cache.InvalidateCartAsync(cognitoSub, ct);

                // No _failed branch, for the same reason the read has none: this method
                // names no failure of its own. A DB fault throws out of TraceWorkflowAsync,
                // which records it on the span and sets ERROR status.
                //
                // Deliberately says nothing about whether a cart existed. DELETE is
                // idempotent by contract, so "deleted nothing" is a success, not a
                // distinct outcome worth a second app_event value.
                _logger.LogInformation("Cart deleted {app_event}", "delete_cart_succeeded");

                return true;
            });
    }

    /// <summary>
    /// Soft-deletes a user's active cart and its lines on the GIVEN context, without
    /// saving.
    /// </summary>
    /// <remarks>
    /// Static and context-taking so order creation can call it INSIDE its own
    /// transaction (see CreateOrderService) rather than duplicating the deletion
    /// logic. There are three call sites — an emptying PUT, DELETE /v1/cart, and a
    /// completed order — and they must not be allowed to drift apart. The caller
    /// owns SaveChanges, which is what lets the order path make cart removal part
    /// of the same atomic commit as the order itself.
    /// </remarks>
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

    private static void SoftDelete(Cart cart)
    {
        var now = DateTime.UtcNow;
        cart.DeletedAt = now;

        // The lines go too. Leaving them live would keep the cart_item unique index
        // occupied, so the user's NEXT cart could not hold the same product.
        foreach (var item in cart.Items)
        {
            item.DeletedAt = now;
        }
    }

    private static void SyncLines(Cart cart, IReadOnlyList<CartLineInput> wanted)
    {
        var now = DateTime.UtcNow;
        var wantedById = wanted.ToDictionary(i => i.ProductId, i => i.Quantity);

        // Remove what the caller no longer wants. Replacement semantics: absence from
        // the command IS the instruction to remove.
        foreach (var existing in cart.Items.Where(i => !wantedById.ContainsKey(i.ProductId)))
        {
            existing.DeletedAt = now;
        }

        foreach (var (productId, quantity) in wantedById)
        {
            // `&& !i.IsDeleted` is load-bearing, not defensive. The loop above may have
            // just set DeletedAt on a line in this same collection; without the filter
            // this would find that row and set its Quantity, leaving DeletedAt in place —
            // a line that is updated and invisible at the same time, since BuildAsync
            // filters deleted lines out. The result would be a product silently missing
            // from the cart the caller just asked for.
            //
            // No input reaches that state today: the endpoint rejects duplicate
            // productIds, so a product cannot be both absent from and present in one
            // command. But ReplaceAsync is public and that validation lives one layer
            // up, so the guard belongs here, where the invariant actually is.
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
