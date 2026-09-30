using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Orders.Application.Orders;

/// <summary>
/// The SHA-256 hex fingerprint of the purchase a <see cref="CreateOrderCommand"/> describes,
/// stored beside its Idempotency-Key.
/// </summary>
/// <remarks>
/// CONTRACT: Hash the CANONICAL purchase, never the raw JSON — lines consolidated per product and
/// sorted ordinally, plus the payment method. Raw bytes differ on key order or whitespace, and a
/// legitimate retry would then answer 422. See [[2026-09-19-stripe-payments-design]]
/// </remarks>
public static class CreateOrderFingerprint
{
    // WARNING: Any change to the canonical shape changes every stored hash, so a client retry
    // spanning that deploy answers 422. Change it together with this tag.
    private const string Version = "v1";

    public static string Compute(CreateOrderCommand command)
    {
        var lines = command.Lines
            .GroupBy(l => l.ProductId, StringComparer.Ordinal)
            .Select(g => new object[] { g.Key, g.Sum(l => (long)l.Quantity) })
            .OrderBy(l => (string)l[0], StringComparer.Ordinal)
            .ToArray();
        var canonical = JsonSerializer.Serialize(new object?[] { Version, lines, command.PaymentMethodId });
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
    }
}
