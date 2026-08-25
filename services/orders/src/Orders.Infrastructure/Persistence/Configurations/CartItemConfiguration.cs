using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Infrastructure.Persistence.Configurations;

public class CartItemConfiguration : IEntityTypeConfiguration<CartItem>
{
    /// <summary>
    /// Same trick as CartConfiguration.ActiveUserIdColumn, one level down: it holds
    /// the cart id while the line is live and NULL once soft-deleted, so a cart cannot
    /// hold two live lines for the same product while keeping its deleted history.
    /// </summary>
    public const string ActiveCartIdColumn = "active_cart_id";

    public void Configure(EntityTypeBuilder<CartItem> b)
    {
        b.ToTable("cart_item");
        b.HasKey(i => i.Id);
        b.Property(i => i.Id).HasColumnName("id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(i => i.CartId).HasColumnName("cart_id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(i => i.ProductId).HasColumnName("product_id").HasMaxLength(NanoIdConfig.TotalLength);
        // uint maps to MySQL `int unsigned`; a cart line is never negative and the
        // API rejects a negative quantity before it reaches here.
        b.Property(i => i.Quantity).HasColumnName("quantity");
        ProductConfiguration.ApplyAudit(b);
        b.Ignore(i => i.IsDeleted);

        b.Property<string?>(ActiveCartIdColumn)
            .HasColumnName(ActiveCartIdColumn)
            .HasMaxLength(NanoIdConfig.TotalLength)
            .HasComputedColumnSql(
                "(CASE WHEN `deleted_at` IS NULL THEN `cart_id` ELSE NULL END)",
                stored: true);

        b.HasIndex(ActiveCartIdColumn, nameof(CartItem.ProductId))
            .IsUnique()
            .HasDatabaseName("uq_cart_item_active_cart_product");

        b.HasIndex(i => i.DeletedAt).HasDatabaseName("idx_cart_item_deleted_at");
        b.HasQueryFilter(i => i.DeletedAt == null);
    }
}
