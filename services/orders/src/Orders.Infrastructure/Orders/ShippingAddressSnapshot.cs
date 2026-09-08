using System.Text.Json;
using System.Text.Json.Serialization;
using Orders.Application.Identity;

namespace Orders.Infrastructure.Orders;

/// <summary>
/// Serializes a resolved <see cref="CallerAddress"/> into the raw JSON stored on
/// <c>Order.ShippingAddress</c>.
/// </summary>
/// <remarks>
/// CONTRACT: Spell the snake_case names as explicit <see cref="JsonPropertyName"/> literals.
/// This string is stored on the order AND embedded verbatim in what Tracking persists, so the
/// names are a cross-service contract a C# rename must not rewrite. Drop null fields rather
/// than writing <c>null</c> keys.
/// WARNING: PII. Never log it. See [[logging-context]]
/// </remarks>
public static class ShippingAddressSnapshot
{
    /// <summary>
    /// Serializes the address to JSON, or returns <c>null</c> when there is nothing to
    /// snapshot (no address on file, or an address whose every field is absent).
    /// </summary>
    public static string? Serialize(CallerAddress? address)
    {
        // IsEmpty is re-checked here rather than trusted from the adapter: this method is
        // the last gate before the value is persisted, and an all-null address must become
        // a NULL column, never the string "{}" that reads as "we have an address".
        if (address is null || address.IsEmpty) return null;

        return JsonSerializer.Serialize(
            new AddressJson(
                address.Line1,
                address.Line2,
                address.City,
                address.State,
                address.Country,
                address.PostalCode),
            JsonOptions);
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        // Absent fields are omitted rather than written as null — see the remarks above.
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    // Frozen wire shape. Mirrors users.v1.Address / tracking.v1.Address field for field.
    private sealed record AddressJson(
        [property: JsonPropertyName("line1")] string? Line1,
        [property: JsonPropertyName("line2")] string? Line2,
        [property: JsonPropertyName("city")] string? City,
        [property: JsonPropertyName("state")] string? State,
        [property: JsonPropertyName("country")] string? Country,
        [property: JsonPropertyName("postal_code")] string? PostalCode);
}
