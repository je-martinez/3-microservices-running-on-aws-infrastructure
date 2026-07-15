using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Orders.Domain.Entities;

namespace Orders.Infrastructure.Persistence.Configurations;

public class OrderConfiguration : IEntityTypeConfiguration<Order>
{
    public void Configure(EntityTypeBuilder<Order> b)
    {
        b.ToTable("order");
        b.HasKey(o => o.Id);
        b.Property(o => o.Id).HasColumnName("id").HasMaxLength(26);
        b.Property(o => o.UserId).HasColumnName("user_id").HasMaxLength(26);
        b.Property(o => o.CognitoSub).HasColumnName("cognito_sub").HasMaxLength(255);
        b.Property(o => o.SubtotalCents).HasColumnName("subtotal_cents").HasColumnType("bigint");
        b.Property(o => o.TaxCents).HasColumnName("tax_cents").HasColumnType("bigint");
        b.Property(o => o.TotalCents).HasColumnName("total_cents").HasColumnType("bigint");
        ProductConfiguration.ApplyAudit(b);
        b.Ignore(o => o.Subtotal);
        b.Ignore(o => o.Tax);
        b.Ignore(o => o.Total);
        b.Ignore(o => o.IsDeleted);
        b.HasMany(o => o.Details).WithOne().HasForeignKey(d => d.OrderId);
        b.HasIndex(o => o.UserId).HasDatabaseName("idx_order_user_id");
        b.HasIndex(o => o.CognitoSub).HasDatabaseName("idx_order_cognito_sub");
        b.HasIndex(o => o.DeletedAt).HasDatabaseName("idx_order_deleted_at");
        b.HasQueryFilter(o => o.DeletedAt == null);
    }
}
