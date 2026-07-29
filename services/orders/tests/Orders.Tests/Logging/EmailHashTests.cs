using Orders.Api.Logging;
using Xunit;

namespace Orders.Tests.Logging;

public class EmailHashTests
{
    [Fact]
    public void IsStableForTheSameEmail() =>
        Assert.Equal(EmailHash.Compute("user@example.com"), EmailHash.Compute("user@example.com"));

    [Fact]
    public void NormalizesCaseAndSurroundingWhitespace()
    {
        var canonical = EmailHash.Compute("user@example.com");
        Assert.Equal(canonical, EmailHash.Compute("USER@example.com"));
        Assert.Equal(canonical, EmailHash.Compute("  user@example.com  "));
        Assert.Equal(canonical, EmailHash.Compute("User@Example.COM"));
    }

    [Fact]
    public void DiffersForDifferentEmails() =>
        Assert.NotEqual(EmailHash.Compute("a@example.com"), EmailHash.Compute("b@example.com"));

    [Fact]
    public void Is16HexCharacters() =>
        Assert.Matches("^[0-9a-f]{16}$", EmailHash.Compute("user@example.com"));

    [Fact]
    public void DoesNotLeakTheOriginalAddress()
    {
        var hash = EmailHash.Compute("user@example.com");
        Assert.DoesNotContain("user", hash);
        Assert.DoesNotContain("@", hash);
    }

    // THE CROSS-SERVICE CONTRACT. This exact literal is what the Users service's
    // hashEmail("user@example.com") produces, and the Users test pins the same
    // value (services/users/tests/shared/email-hash.test.ts). If either side
    // changes its normalization or truncation, one of the two tests fails here
    // in CI — rather than filtering for a user across services silently
    // returning nothing in production.
    [Fact]
    public void MatchesTheUsersServiceForThePinnedInput() =>
        Assert.Equal("b4c9a289323b21a0", EmailHash.Compute("user@example.com"));
}
