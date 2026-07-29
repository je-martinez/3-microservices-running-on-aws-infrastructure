using System.Security.Cryptography;
using System.Text;

namespace Orders.Api.Logging;

// CROSS-SERVICE CONTRACT: must produce byte-identical output to the Users
// service's hashEmail() in services/users/src/shared/logging/email-hash.ts —
// SHA-256 of the trimmed, lowercased email, hex, first 16 chars.
//
// If the two ever drift, filtering one user across both services silently
// returns nothing: no error, no warning, just no results. Both sides therefore
// pin the same literal in a test (see EmailHashTests), so a drift fails loudly
// in CI instead of quietly in production.
public static class EmailHash
{
    private const int HashLength = 16;

    /// <summary>
    /// A stable, non-reversible id for an email address. Safe to log anywhere.
    /// Plaintext email is confined to the auth flows, where no user id exists yet.
    /// </summary>
    public static string Compute(string email)
    {
        var normalized = email.Trim().ToLowerInvariant();
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(normalized));
        return Convert.ToHexString(digest).ToLowerInvariant()[..HashLength];
    }
}
