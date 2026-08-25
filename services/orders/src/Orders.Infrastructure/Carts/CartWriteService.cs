using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Orders.Application.Abstractions;
using Orders.Application.Carts;
using Orders.Application.Identity;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Observability;
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
    private readonly ILogger<CartWriteService> _logger;

    public CartWriteService(
        OrdersWriteDbContext db,
        IUserDirectory users,
        CartReadService reads,
        IWorkflowTracer tracer,
        ILogger<CartWriteService> logger)
    {
        _db = db;
        _users = users;
        _reads = reads;
        _tracer = tracer;
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
            () => ReplaceInternalAsync(command, cognitoSub, ct));

    private async Task<CartDto> ReplaceInternalAsync(
        UpdateCartCommand command,
        string cognitoSub,
        CancellationToken ct)
    {
        _logger.LogInformation(
            "Starting cart update {app_event} {line_count}",
            "update_cart_started", command.Items.Count);

        // Id-only resolution: this path never needs the caller's PII (email, name,
        // address) — only the internal usr_ id gets stamped onto the cart. See
        // IUserDirectory's doc comment for why the two resolution methods exist.
        var userId = await _users.ResolveInternalUserIdAsync(cognitoSub, ct);
        if (userId is null)
        {
            _logger.LogError(
                "Cart update failed: the caller is not a known user {app_event} {reason}",
                "update_cart_failed", "unknown_user");
            _tracer.SetReason("unknown_user");
            throw new UnknownUserException(cognitoSub);
        }

        // Zero means "remove", so it is dropped here, once, before any persistence
        // logic runs. Everything downstream then deals only in live lines.
        var wanted = command.Items.Where(i => i.Quantity > 0).ToList();

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
                    UserId = userId,
                    CognitoSub = cognitoSub,
                };
                _db.Carts.Add(cart);
            }

            SyncLines(cart, wanted);

            await _db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);

            _logger.LogInformation(
                "Cart updated {app_event} {line_count}", "update_cart_succeeded", wanted.Count);

            return await _reads.BuildAsync(cart, ct);
        });
    }

    /// <summary>Deletes the caller's active cart. Idempotent.</summary>
    public async Task DeleteAsync(string cognitoSub, CancellationToken ct = default)
    {
        await AmbientActor.RunAsync(AuditActor.DeleteCart, async () =>
        {
            await DeleteForUserAsync(_db, cognitoSub, ct);
            await _db.SaveChangesAsync(ct);
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
            var existing = cart.Items.FirstOrDefault(i => i.ProductId == productId);
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
