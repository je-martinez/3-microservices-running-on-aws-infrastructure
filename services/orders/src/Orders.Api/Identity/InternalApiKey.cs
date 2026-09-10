using System.Security.Cryptography;
using System.Text;

namespace Orders.Api.Identity;

/// <summary>
/// Validates the shared internal service-to-service key on inbound requests.
/// CONTRACT: Constant-time comparison, never <c>==</c> — string equality short-circuits at
/// the first differing byte, so its timing leaks how long a prefix an attacker guessed.
/// Mirrors Tracking's <c>hmac.compare_digest</c> and Users' <c>timingSafeEqual</c>; a length
/// mismatch returns early in all three, so the key's LENGTH leaks, its CONTENTS do not.
/// See [[ADR-0003-grpc-inter-service]]
/// </summary>
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
