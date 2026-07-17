using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Orders.Domain.Entities;

namespace Orders.Infrastructure.Persistence.Configurations;

public class ProductConfiguration : IEntityTypeConfiguration<Product>
{
    public void Configure(EntityTypeBuilder<Product> b)
    {
        b.ToTable("product");
        b.HasKey(p => p.Id);
        b.Property(p => p.Id).HasColumnName("id").HasMaxLength(26);
        b.Property(p => p.Name).HasColumnName("name").HasMaxLength(255);
        b.Property(p => p.Description).HasColumnName("description").HasColumnType("text");
        b.Property(p => p.UnitPriceCents).HasColumnName("unit_price_cents").HasColumnType("bigint");
        b.Property(p => p.UnitsInStock).HasColumnName("units_in_stock");
        ApplyAudit(b);
        b.Ignore(p => p.UnitPrice);
        b.Ignore(p => p.IsDeleted);
        b.HasQueryFilter(p => p.DeletedAt == null);
    }

    internal static void ApplyAudit<T>(EntityTypeBuilder<T> b) where T : AuditableEntity
    {
        b.Property(e => e.CreatedBy).HasColumnName("created_by").HasMaxLength(26);
        b.Property(e => e.CreatedAt).HasColumnName("created_at");
        b.Property(e => e.UpdatedBy).HasColumnName("updated_by").HasMaxLength(26);
        b.Property(e => e.UpdatedAt).HasColumnName("updated_at");
        b.Property(e => e.DeletedBy).HasColumnName("deleted_by").HasMaxLength(26);
        b.Property(e => e.DeletedAt).HasColumnName("deleted_at");
    }
}
