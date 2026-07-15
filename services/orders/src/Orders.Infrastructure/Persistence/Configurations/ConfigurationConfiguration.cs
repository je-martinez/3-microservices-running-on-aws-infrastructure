using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Orders.Domain.Entities;

namespace Orders.Infrastructure.Persistence.Configurations;

public class ConfigurationConfiguration : IEntityTypeConfiguration<Configuration>
{
    public void Configure(EntityTypeBuilder<Configuration> b)
    {
        b.ToTable("configuration");
        // The Key is the primary key (not the inherited nano-id Id).
        b.HasKey(c => c.Key);
        b.Property(c => c.Key).HasColumnName("key").HasMaxLength(255);
        b.Property(c => c.Value).HasColumnName("value").HasColumnType("text");
        b.Ignore(c => c.Id);
        ProductConfiguration.ApplyAudit(b);
        b.Ignore(c => c.IsDeleted);
        b.HasQueryFilter(c => c.DeletedAt == null);
    }
}
