using System.Security.Cryptography;
using System.Text;

namespace Orders.Api.Logging;

// CONTRACT: Byte-identical to Users' hashEmail() in
// services/users/src/shared/logging/email-hash.ts — SHA-256 of the trimmed, lowercased
// email, hex, first 16 chars. A drift makes filtering one user across both services return
// nothing at all: no error, no warning, no results. Both sides pin the same literal in a test
// so it fails in CI instead. See [[logging-context]]
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
