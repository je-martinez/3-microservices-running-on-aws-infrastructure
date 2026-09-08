using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Infrastructure.Persistence.Configurations;

public class OrderDetailConfiguration : IEntityTypeConfiguration<OrderDetail>
{
    public void Configure(EntityTypeBuilder<OrderDetail> b)
    {
        b.ToTable("order_details");
        b.HasKey(d => d.Id);
        b.Property(d => d.Id).HasColumnName("id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(d => d.OrderId).HasColumnName("order_id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(d => d.ProductId).HasColumnName("product_id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(d => d.UserId).HasColumnName("user_id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(d => d.CognitoSub).HasColumnName("cognito_sub").HasMaxLength(255);
        b.Property(d => d.Quantity).HasColumnName("quantity");
        b.Property(d => d.SubtotalCents).HasColumnName("subtotal_cents").HasColumnType("bigint");
        b.Property(d => d.TaxCents).HasColumnName("tax_cents").HasColumnType("bigint");
        b.Property(d => d.TotalCents).HasColumnName("total_cents").HasColumnType("bigint");

        // Purchase-time snapshot of the catalogue, so a rename or a re-shoot never rewrites
        // a past receipt. Both nullable: rows predating these columns have no snapshot, and
        // a product may legitimately have no artwork. Same converter as product.image, so
        // the stored `uri` is a bucket key relative to ASSETS_BASE_URL.
        b.Property(d => d.ProductName).HasColumnName("product_name").HasMaxLength(255);
        b.Property(d => d.ProductImage)
            .HasColumnName("product_image")
            .HasColumnType("json")
            .HasConversion(ProductJsonConverters.ImageConverter, ProductJsonConverters.ImageComparer);

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
