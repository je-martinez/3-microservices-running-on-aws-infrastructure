using System.Security.Cryptography;
using System.Text;

namespace Orders.Api.Identity;

/// <summary>
/// Validates the shared internal service-to-service key (ADR-0003) on inbound
/// requests. Orders previously only ever PRESENTED this key outbound (to Users
/// over gRPC); the account-deletion cascade is the first surface that has to
/// verify it.
/// </summary>
/// <remarks>
/// Constant-time comparison, never <c>==</c>: string equality short-circuits at
/// the first differing byte, so its timing leaks how long a prefix an attacker
/// guessed. This mirrors Tracking's <c>hmac.compare_digest</c> and Users'
/// <c>timingSafeEqual</c>. A length mismatch returns early in every
/// implementation — the key's LENGTH leaks, its CONTENTS do not.
/// </remarks>
public static class InternalApiKey
{
    public const string HeaderName = "x-api-key";

    public static bool Matches(string? provided, string expected)
    {
        if (provided is null) return false;

        var a = Encoding.UTF8.GetBytes(provided);
        var b = Encoding.UTF8.GetBytes(expected);
        if (a.Length != b.Length) return false;

        return CryptographicOperations.FixedTimeEquals(a, b);
    }
}
