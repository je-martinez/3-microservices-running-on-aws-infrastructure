using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Infrastructure.Persistence.Configurations;

public class CartConfiguration : IEntityTypeConfiguration<Cart>
{
    /// <summary>
    /// The generated column backing the one-active-cart invariant: it equals
    /// <c>user_id</c> while the row is live and is NULL once soft-deleted. MySQL
    /// ignores NULLs in a unique index, so a user may accumulate any number of
    /// deleted carts and at most one active one.
    /// </summary>
    public const string ActiveUserIdColumn = "active_user_id";

    public void Configure(EntityTypeBuilder<Cart> b)
    {
        b.ToTable("cart");
        b.HasKey(c => c.Id);
        b.Property(c => c.Id).HasColumnName("id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(c => c.UserId).HasColumnName("user_id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(c => c.CognitoSub).HasColumnName("cognito_sub").HasMaxLength(255);
        ProductConfiguration.ApplyAudit(b);
        b.Ignore(c => c.IsDeleted);

        // Restrict, not the default Cascade: cart_item.cart_id feeds cart_item's own
        // active_cart_id generated column (see CartItemConfiguration), and InnoDB
        // rejects a CASCADE/SET NULL foreign key on a column a generated column
        // depends on ("Cannot add foreign key constraint", errno 1215). Soft-delete-only
        // ([[soft-delete]]) means a hard DELETE FROM cart never happens in this service
        // anyway, so RESTRICT costs nothing in practice.
        b.HasMany(c => c.Items).WithOne().HasForeignKey(i => i.CartId).OnDelete(DeleteBehavior.Restrict);

        // The invariant itself. Declared as a STORED generated column so the unique
        // index can cover it; a virtual column cannot be indexed the same way across
        // MySQL versions. The expression must stay in sync with the query filter
        // below — both define "active" as deleted_at IS NULL.
        b.Property<string?>(ActiveUserIdColumn)
            .HasColumnName(ActiveUserIdColumn)
            .HasMaxLength(NanoIdConfig.TotalLength)
            .HasComputedColumnSql(
                "(CASE WHEN `deleted_at` IS NULL THEN `user_id` ELSE NULL END)",
                stored: true);

        b.HasIndex(ActiveUserIdColumn)
            .IsUnique()
            .HasDatabaseName("uq_cart_active_user_id");

        b.HasIndex(c => c.CognitoSub).HasDatabaseName("idx_cart_cognito_sub");
        b.HasIndex(c => c.DeletedAt).HasDatabaseName("idx_cart_deleted_at");
        b.HasQueryFilter(c => c.DeletedAt == null);
    }
}
