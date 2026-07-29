using System.Text.Json;
using System.Text.Json.Serialization;
using Orders.Application.Identity;

namespace Orders.Infrastructure.Orders;

/// <summary>
/// Serializes a resolved <see cref="CallerAddress"/> into the raw JSON stored on
/// <c>Order.ShippingAddress</c>.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why snake_case, spelled out literally.</b> This exact JSON is stored on the order
/// AND handed to <c>ITrackingInitiator</c>, which re-parses it and embeds it verbatim in
/// the body Tracking persists. One string therefore ends up in three places, so its field
/// names are a cross-service contract, not an implementation detail: they must match
/// <c>users.v1.Address</c> / <c>tracking.v1.Address</c> one for one. The names are written
/// as explicit <see cref="JsonPropertyName"/> literals rather than left to a naming policy
/// so that renaming a C# property cannot silently rewrite the wire shape.
/// </para>
/// <para>
/// <b>Why null fields are dropped.</b> The gRPC adapter already normalized proto3's empty
/// strings to null, meaning "absent". Writing them back as <c>null</c> keys would re-inflate
/// that noise into the stored snapshot and into Tracking's copy; omitting them keeps
/// "absent" spelled exactly one way, matching the logging convention's same rule for fields.
/// </para>
/// <para>
/// PII — the produced string is the shipping address. Never log it.
/// </para>
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
