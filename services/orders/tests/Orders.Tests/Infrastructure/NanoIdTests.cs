using Orders.Infrastructure.Id;

namespace Orders.Tests.Infrastructure;

// The id format is a CROSS-SERVICE CONTRACT: ids travel in headers, SQS envelopes and
// foreign keys, so Users (tests/shared/nano-id.test.ts) and Tracking pin the same three
// values (alphabet, length, prefix width) in their own suites. A change here that is not
// mirrored there produces ids the other services reject.
public class NanoIdTests
{
    [Fact]
    public void Alphabet_contains_only_letters_and_digits()
    {
        Assert.Matches("^[A-Za-z0-9]+$", NanoIdConfig.Alphabet);
    }

    [Fact]
    public void Alphabet_excludes_the_two_characters_nanoid_adds_by_default()
    {
        // `-` reads as a flag when an id is pasted into a shell; `_` disappears against an
        // underscored column name. Dropping them is the whole point of the custom alphabet.
        Assert.DoesNotContain('_', NanoIdConfig.Alphabet);
        Assert.DoesNotContain('-', NanoIdConfig.Alphabet);
    }

    [Fact]
    public void Alphabet_has_no_duplicate_characters()
    {
        // A repeated character biases the distribution toward it, silently reducing
        // entropy below what the length implies.
        Assert.Equal(NanoIdConfig.Alphabet.Length, NanoIdConfig.Alphabet.Distinct().Count());
    }

    [Fact]
    public void Alphabet_covers_all_62_alphanumerics()
    {
        Assert.Equal(62, NanoIdConfig.Alphabet.Length);
    }

    [Fact]
    public void NewId_produces_a_prefix_plus_24_alphabet_characters()
    {
        var id = NanoId.NewId(NanoId.OrderPrefix);

        Assert.Matches(@"^ord_[A-Za-z0-9]{24}$", id);
        Assert.Equal(NanoIdConfig.TotalLength, id.Length);
    }

    [Fact]
    public void Total_length_is_the_width_every_id_column_is_sized_for()
    {
        // 28. MySQL truncates a too-long value silently rather than erroring, so this
        // number and the column width must agree.
        Assert.Equal(28, NanoIdConfig.TotalLength);
        Assert.Equal(NanoIdConfig.PrefixLength + NanoIdConfig.Length, NanoIdConfig.TotalLength);
    }

    [Fact]
    public void NewId_never_emits_a_character_outside_the_alphabet_and_never_collides()
    {
        // A few thousand ids ≈ 100k characters: enough that a stray `_`/`-` from a default
        // alphabet would show up rather than hiding behind a lucky sample.
        const int sampleSize = 5_000;
        var ids = new HashSet<string>();

        for (var i = 0; i < sampleSize; i++)
        {
            var id = NanoId.NewId(NanoId.OrderPrefix);
            ids.Add(id);

            foreach (var c in id.AsSpan(NanoIdConfig.PrefixLength))
            {
                Assert.Contains(c, NanoIdConfig.Alphabet);
            }
        }

        Assert.Equal(sampleSize, ids.Count);
    }

    [Fact]
    public void Prefixes_are_all_three_characters_and_an_underscore()
    {
        foreach (var prefix in NanoIdConfig.Prefixes)
        {
            Assert.Matches("^[a-z]{3}_$", prefix);
            Assert.Equal(NanoIdConfig.PrefixLength, prefix.Length);
        }
    }

    [Fact]
    public void Prefixes_are_unique_so_an_id_names_its_own_type()
    {
        Assert.Equal(NanoIdConfig.Prefixes.Count, NanoIdConfig.Prefixes.Distinct().Count());
    }

    [Fact]
    public void PatternFor_accepts_what_the_generator_produces()
    {
        foreach (var prefix in NanoIdConfig.Prefixes)
        {
            Assert.Matches(NanoIdConfig.PatternFor(prefix), NanoId.NewId(prefix));
        }
    }

    [Fact]
    public void PatternFor_rejects_the_previous_21_character_format()
    {
        // The regression this refactor could cause: a service still minting the old shape
        // would be silently rejected at every boundary.
        var pattern = NanoIdConfig.PatternFor(NanoId.OrderPrefix);

        // The old shape: 21 characters, and from an alphabet that included `-`.
        Assert.DoesNotMatch(pattern, "ord_V1StGXR8_Z5jdHi6B-myT");
        // The old LENGTH alone is enough to reject, even in the new alphabet.
        Assert.DoesNotMatch(pattern, "ord_V1StGXR8Z5jdHi6BmyTxq");
    }

    [Fact]
    public void PatternFor_rejects_a_wrong_prefix()
    {
        // Prefixes are what let a log query tell an order from a product; a pattern that
        // matched any prefix would make the distinction decorative.
        Assert.DoesNotMatch(
            NanoIdConfig.PatternFor(NanoId.OrderPrefix),
            NanoId.NewId(NanoId.ProductPrefix));
    }
}
