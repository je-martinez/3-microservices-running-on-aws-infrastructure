using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Infrastructure.Persistence.Configurations;

public class ProductConfiguration : IEntityTypeConfiguration<Product>
{
    public void Configure(EntityTypeBuilder<Product> b)
    {
        b.ToTable("product");
        b.HasKey(p => p.Id);
        b.Property(p => p.Id).HasColumnName("id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(p => p.Name).HasColumnName("name").HasMaxLength(255);
        b.Property(p => p.Description).HasColumnName("description").HasColumnType("text");
        b.Property(p => p.UnitPriceCents).HasColumnName("unit_price_cents").HasColumnType("bigint");
        b.Property(p => p.UnitsInStock).HasColumnName("units_in_stock");

        // Display artwork. Nullable `json` — a product may have none. The stored `uri`
        // is a bucket key RELATIVE to the assets base URL; composing the absolute URL
        // is the read service's job (see ProductReadService).
        b.Property(p => p.Image)
            .HasColumnName("image")
            .HasColumnType("json")
            .HasConversion(ProductJsonConverters.ImageConverter, ProductJsonConverters.ImageComparer);

        // Catalogue facets, e.g. ["FOOTWEAR"]. JSON array because MySQL 8 has no array
        // type. Non-nullable with an empty-array default so an uncategorised product
        // reads back as [] rather than null.
        b.Property(p => p.Categories)
            .HasColumnName("categories")
            .HasColumnType("json")
            .HasConversion(ProductJsonConverters.CategoriesConverter, ProductJsonConverters.CategoriesComparer)
            .HasDefaultValue(new List<string>())
            .IsRequired();

        ApplyAudit(b);
        b.Ignore(p => p.UnitPrice);
        b.Ignore(p => p.IsDeleted);
        b.HasQueryFilter(p => p.DeletedAt == null);
    }

    internal static void ApplyAudit<T>(EntityTypeBuilder<T> b) where T : AuditableEntity
    {
        b.Property(e => e.CreatedBy).HasColumnName("created_by").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(e => e.CreatedAt).HasColumnName("created_at");
        b.Property(e => e.UpdatedBy).HasColumnName("updated_by").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(e => e.UpdatedAt).HasColumnName("updated_at");
        b.Property(e => e.DeletedBy).HasColumnName("deleted_by").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(e => e.DeletedAt).HasColumnName("deleted_at");
    }
}
