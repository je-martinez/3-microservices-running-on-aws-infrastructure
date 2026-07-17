using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Orders.Domain.Entities;

namespace Orders.Infrastructure.Persistence.Configurations;

public class OrderDetailConfiguration : IEntityTypeConfiguration<OrderDetail>
{
    public void Configure(EntityTypeBuilder<OrderDetail> b)
    {
        b.ToTable("order_details");
        b.HasKey(d => d.Id);
        b.Property(d => d.Id).HasColumnName("id").HasMaxLength(26);
        b.Property(d => d.OrderId).HasColumnName("order_id").HasMaxLength(26);
        b.Property(d => d.ProductId).HasColumnName("product_id").HasMaxLength(26);
        b.Property(d => d.UserId).HasColumnName("user_id").HasMaxLength(26);
        b.Property(d => d.CognitoSub).HasColumnName("cognito_sub").HasMaxLength(255);
        b.Property(d => d.Quantity).HasColumnName("quantity");
        b.Property(d => d.SubtotalCents).HasColumnName("subtotal_cents").HasColumnType("bigint");
        b.Property(d => d.TaxCents).HasColumnName("tax_cents").HasColumnType("bigint");
        b.Property(d => d.TotalCents).HasColumnName("total_cents").HasColumnType("bigint");
        ProductConfiguration.ApplyAudit(b);
        b.Ignore(d => d.Subtotal);
        b.Ignore(d => d.Tax);
        b.Ignore(d => d.Total);
        b.Ignore(d => d.IsDeleted);
        b.HasIndex(d => d.OrderId).HasDatabaseName("idx_order_details_order_id");
        b.HasIndex(d => d.ProductId).HasDatabaseName("idx_order_details_product_id");
        b.HasIndex(d => d.DeletedAt).HasDatabaseName("idx_order_details_deleted_at");
        b.HasQueryFilter(d => d.DeletedAt == null);
    }
}
