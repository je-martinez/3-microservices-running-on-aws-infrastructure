using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Orders.Domain.Entities;

namespace Orders.Infrastructure.Persistence;

/// <summary>
/// Value converters for the product table's two JSON columns.
/// </summary>
/// <remarks>
/// <para>
/// Deliberately hand-written converters rather than EF's <c>OwnsOne().ToJson()</c>: this
/// service already stores JSON this way for <c>Order.Tags</c> and
/// <c>Order.ShippingAddress</c>, and a JSON-owned type would model these as nested entity
/// types instead of the scalar columns they are.
/// </para>
/// <para>
/// The wire shape is snake_case with EXPLICIT <see cref="JsonPropertyName"/> literals,
/// following ShippingAddressSnapshot's reasoning: this JSON is persisted data, so its
/// field names are a contract. Renaming a C# property must not silently rewrite rows.
/// </para>
/// </remarks>
internal static class ProductJsonConverters
{
    // Frozen wire shape for the `image` column. Field names are the contract.
    private sealed record ProductImageJson(
        [property: JsonPropertyName("uri")] string Uri,
        [property: JsonPropertyName("width")] int Width,
        [property: JsonPropertyName("height")] int Height,
        [property: JsonPropertyName("blurhash")] string Blurhash);

    internal static readonly ValueConverter<ProductImage?, string?> ImageConverter = new(
        image => image == null
            ? null
            : JsonSerializer.Serialize(
                new ProductImageJson(image.Uri, image.Width, image.Height, image.Blurhash),
                (JsonSerializerOptions?)null),
        // Blank is treated as absent, not as a parse error: rows written before this
        // column existed hold SQL NULL, and a defensive read costs nothing.
        json => string.IsNullOrWhiteSpace(json)
            ? null
            : Deserialize(json));

    private static ProductImage? Deserialize(string json)
    {
        var dto = JsonSerializer.Deserialize<ProductImageJson>(json, (JsonSerializerOptions?)null);
        return dto == null ? null : new ProductImage(dto.Uri, dto.Width, dto.Height, dto.Blurhash);
    }

    // ProductImage is an immutable record, so reference equality would still miss a
    // REPLACED instance with equal contents. Records give value equality via Equals,
    // which is what we want; the snapshot returns the same instance, safe precisely
    // because the record cannot be mutated in place.
    internal static readonly ValueComparer<ProductImage?> ImageComparer = new(
        (a, b) => Equals(a, b),
        image => image == null ? 0 : image.GetHashCode(),
        image => image);

    internal static readonly ValueConverter<List<string>, string> CategoriesConverter = new(
        categories => JsonSerializer.Serialize(categories, (JsonSerializerOptions?)null),
        // Null/blank -> empty list, NEVER null: Product.Categories is non-nullable and
        // rows predating the column read back as SQL NULL.
        json => string.IsNullOrWhiteSpace(json)
            ? new List<string>()
            : JsonSerializer.Deserialize<List<string>>(json, (JsonSerializerOptions?)null)
              ?? new List<string>());

    // REQUIRED for a converted MUTABLE reference type. Without it EF compares
    // List<string> by reference, so `product.Categories.Add("BAGS")` on a tracked
    // entity is never detected and the UPDATE is silently skipped. Mirrors
    // OrderConfiguration.TagsComparer.
    internal static readonly ValueComparer<List<string>> CategoriesComparer = new(
        (a, b) => a != null && b != null ? a.SequenceEqual(b) : a == b,
        categories => categories.Aggregate(0, (hash, c) => HashCode.Combine(hash, c.GetHashCode())),
        categories => categories.ToList());
}
