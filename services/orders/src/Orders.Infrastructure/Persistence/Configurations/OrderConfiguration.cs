using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;

namespace Orders.Infrastructure.Persistence.Configurations;

public class OrderConfiguration : IEntityTypeConfiguration<Order>
{
    // Tags <-> MySQL `json`. MySQL 8 has no native array type (unlike Postgres, which
    // is what Users uses), so the list is serialized to a JSON array string. Domain
    // keeps a plain List<string> and never learns about the storage shape.
    //
    // Deliberately serialized here rather than with EF's OwnsMany/ToJson: this is a
    // scalar column the cleanup query has to filter on with MySQL's JSON_CONTAINS
    // (see E2eEndpoints), and a JSON-owned collection would model it as a nested
    // entity type instead.
    private static readonly ValueConverter<List<string>, string> TagsConverter = new(
        tags => JsonSerializer.Serialize(tags, (JsonSerializerOptions?)null),
        // Null/blank -> empty list, never null: Order.Tags is non-nullable, and rows
        // written before this column existed have SQL NULL in it.
        json => string.IsNullOrWhiteSpace(json)
            ? new List<string>()
            : JsonSerializer.Deserialize<List<string>>(json, (JsonSerializerOptions?)null) ?? new List<string>());

    // Required for any converted MUTABLE reference type. Without it EF compares
    // List<string> by reference, so it cannot detect that an entry was added to an
    // existing order's tags and would silently skip the UPDATE.
    private static readonly ValueComparer<List<string>> TagsComparer = new(
        (a, b) => a != null && b != null ? a.SequenceEqual(b) : a == b,
        tags => tags.Aggregate(0, (hash, tag) => HashCode.Combine(hash, tag.GetHashCode())),
        tags => tags.ToList());

    public void Configure(EntityTypeBuilder<Order> b)
    {
        b.ToTable("order");
        b.HasKey(o => o.Id);
        b.Property(o => o.Id).HasColumnName("id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(o => o.UserId).HasColumnName("user_id").HasMaxLength(NanoIdConfig.TotalLength);
        b.Property(o => o.CognitoSub).HasColumnName("cognito_sub").HasMaxLength(255);
        b.Property(o => o.SubtotalCents).HasColumnName("subtotal_cents").HasColumnType("bigint");
        b.Property(o => o.TaxCents).HasColumnName("tax_cents").HasColumnType("bigint");
        // Order-level delivery cost (see Order.ShippingCents), part of total_cents.
        // NOT NULL with a 0 default so rows written before this column existed read
        // back as "no shipping charged" rather than null — they genuinely had none.
        b.Property(o => o.ShippingCents)
            .HasColumnName("shipping_cents")
            .HasColumnType("bigint")
            .HasDefaultValue(0L)
            .IsRequired();
        b.Property(o => o.TotalCents).HasColumnName("total_cents").HasColumnType("bigint");
        // Point-in-time snapshot of the delivery address (see Order.ShippingAddress).
        // Real MySQL `json` column, nullable — a user may have no address on file.
        // Mirrors Tracking's own `shipping_address` JSON column so the two snapshots
        // stay recognisably the same shape. PII: never log it.
        b.Property(o => o.ShippingAddress).HasColumnName("shipping_address").HasColumnType("json");
        // Labels on the order (see Order.Tags). Stored as a JSON array so the E2E
        // cleanup can select rows by tag; non-nullable with an empty-array default so
        // an untagged order reads back as [] rather than null.
        b.Property(o => o.Tags)
            .HasColumnName("tags")
            .HasColumnType("json")
            .HasConversion(TagsConverter, TagsComparer)
            .HasDefaultValue(new List<string>())
            .IsRequired();
        ProductConfiguration.ApplyAudit(b);
        b.Ignore(o => o.Subtotal);
        b.Ignore(o => o.Tax);
        b.Ignore(o => o.Shipping);
        b.Ignore(o => o.Total);
        b.Ignore(o => o.IsDeleted);
        b.HasMany(o => o.Details).WithOne().HasForeignKey(d => d.OrderId);
        b.HasIndex(o => o.UserId).HasDatabaseName("idx_order_user_id");
        b.HasIndex(o => o.CognitoSub).HasDatabaseName("idx_order_cognito_sub");
        b.HasIndex(o => o.DeletedAt).HasDatabaseName("idx_order_deleted_at");
        b.HasQueryFilter(o => o.DeletedAt == null);
    }
}
