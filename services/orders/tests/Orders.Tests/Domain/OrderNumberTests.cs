using Orders.Domain;

namespace Orders.Tests.Domain;

/// <summary>
/// The customer-facing order number's format, and the properties support depends on.
/// </summary>
public class OrderNumberTests
{
    /// <summary>
    /// CONTRACT: Crockford base32 — no <c>I</c>, <c>L</c>, <c>O</c> or <c>U</c>. Excluding
    /// them is the entire reason the value is transcribable, so a "tidy-up" that restores the
    /// full alphabet must fail here rather than surface as misread numbers on support calls.
    /// </summary>
    [Fact]
    public void The_alphabet_excludes_every_character_a_human_confuses()
    {
        foreach (var excluded in new[] { 'I', 'L', 'O', 'U' })
        {
            Assert.DoesNotContain(excluded, OrderNumberConfig.Alphabet);
        }

        Assert.Equal(32, OrderNumberConfig.Alphabet.Length);
        // Uppercase and digits only: "capital R, lowercase b" is not a phone conversation.
        Assert.Equal(OrderNumberConfig.Alphabet, OrderNumberConfig.Alphabet.ToUpperInvariant());
    }

    [Fact]
    public void A_minted_number_is_the_date_prefix_plus_a_suffix_from_the_alphabet()
    {
        var number = OrderNumber.New(new DateTime(2026, 9, 7, 12, 0, 0, DateTimeKind.Utc));

        Assert.Equal(OrderNumberConfig.TotalLength, number.Length);
        Assert.StartsWith("260907", number);
        Assert.True(OrderNumber.IsCanonical(number), $"{number} is not canonical");
    }

    /// <summary>
    /// CONTRACT: The prefix is UTC, never the host's zone. Two orders either side of local
    /// midnight would otherwise land on different dates depending on which host served the
    /// request, and the number would stop being reproducible from the stored created_at.
    /// </summary>
    [Fact]
    public void The_date_prefix_is_computed_in_UTC_not_the_hosts_zone()
    {
        // 01:30 UTC on the 7th. Anywhere west of UTC this instant is still the 6th locally,
        // so a formatter reading local time prints 260906 here.
        var justAfterUtcMidnight = new DateTime(2026, 9, 7, 1, 30, 0, DateTimeKind.Utc);

        Assert.Equal("260907", OrderNumber.DatePrefix(justAfterUtcMidnight));
    }

    /// <summary>
    /// The mirror case: an instant late in the UTC evening is already the NEXT day east of
    /// UTC, so a local-time reading rolls the prefix forward.
    /// </summary>
    [Fact]
    public void The_date_prefix_does_not_roll_forward_late_in_the_UTC_day()
    {
        var lateUtcEvening = new DateTime(2026, 9, 7, 23, 30, 0, DateTimeKind.Utc);

        Assert.Equal("260907", OrderNumber.DatePrefix(lateUtcEvening));
    }

    /// <summary>
    /// CONTRACT: MySQL returns every instant <c>Unspecified</c>, which
    /// <c>ToUniversalTime()</c> shifts by the host's offset — moving a 23:30Z order onto the
    /// next day west of UTC. See [[friendly-order-number]]
    /// </summary>
    [Fact]
    public void An_unspecified_kind_instant_is_not_shifted_by_the_hosts_offset()
    {
        var fromDatabase = new DateTime(2026, 9, 7, 23, 30, 0, DateTimeKind.Unspecified);
        var sameInstantUtc = new DateTime(2026, 9, 7, 23, 30, 0, DateTimeKind.Utc);

        Assert.Equal(OrderNumber.DatePrefix(sameInstantUtc), OrderNumber.DatePrefix(fromDatabase));
    }

    [Fact]
    public void Format_inserts_exactly_one_hyphen_between_date_and_suffix()
    {
        Assert.Equal("260907-8KJ4M2", OrderNumber.Format("2609078KJ4M2"));
    }

    /// <summary>
    /// A stored value of the wrong width cannot be split meaningfully. Returning it untouched
    /// keeps a support surface readable rather than throwing while rendering.
    /// </summary>
    [Fact]
    public void Format_leaves_a_malformed_value_alone_rather_than_throwing()
    {
        Assert.Equal("short", OrderNumber.Format("short"));
    }

    /// <summary>
    /// CONTRACT: A customer types the number off an email with or without the hyphen, in
    /// either case. All four spellings must reach the same stored value, or the lookup
    /// reports a real order as missing.
    /// </summary>
    [Theory]
    [InlineData("260907-8KJ4M2")]
    [InlineData("2609078KJ4M2")]
    [InlineData("260907-8kj4m2")]
    [InlineData("  260907-8KJ4M2  ")]
    public void Normalize_maps_every_spelling_a_customer_types_to_the_canonical_form(string typed)
    {
        Assert.Equal("2609078KJ4M2", OrderNumber.Normalize(typed));
    }

    [Fact]
    public void IsCanonical_rejects_the_displayed_form_and_accepts_the_stored_one()
    {
        Assert.True(OrderNumber.IsCanonical("2609078KJ4M2"));
        // The hyphen belongs to display only; it never reaches the column.
        Assert.False(OrderNumber.IsCanonical("260907-8KJ4M2"));
        Assert.False(OrderNumber.IsCanonical(null));
        Assert.False(OrderNumber.IsCanonical(""));
        // `I` is not in the alphabet, so a value carrying one was never minted here.
        Assert.False(OrderNumber.IsCanonical("2609078KJ4MI"));
    }

    /// <summary>
    /// Not a proof of uniqueness — the unique index is what guarantees that. This pins that
    /// the suffix is actually RANDOM: a generator that returned a constant, or one seeded
    /// from the clock and called in a tight loop, collapses here.
    /// </summary>
    [Fact]
    public void Minting_repeatedly_for_one_instant_produces_distinct_suffixes()
    {
        var instant = new DateTime(2026, 9, 7, 12, 0, 0, DateTimeKind.Utc);

        var minted = Enumerable.Range(0, 500).Select(_ => OrderNumber.New(instant)).ToList();

        var distinct = minted.Distinct().Count();
        Assert.True(
            distinct >= 495,
            $"500 mints for one instant yielded only {distinct} distinct values — the suffix " +
            "is not drawn from a cryptographic source, or the alphabet collapsed");
    }

    /// <summary>
    /// CONTRACT: The backfill's SQL repeats the alphabet as a literal, because a constant
    /// cannot cross the C#/SQL boundary. This is the only thing that catches a drift between
    /// them — without it, backfilled numbers could contain characters the minted ones never
    /// use, and <see cref="OrderNumber.IsCanonical"/> would reject rows the service wrote.
    /// See [[friendly-order-number]]
    /// </summary>
    [Fact]
    public void The_backfill_migration_uses_the_same_alphabet_as_the_generator()
    {
        var migration = Directory
            .EnumerateFiles(MigrationsDirectory(), "*_AddOrderNumber.cs")
            .Single();

        var sql = File.ReadAllText(migration);

        Assert.Contains(
            OrderNumberConfig.Alphabet,
            sql);

        // And the same date rule: MySQL's %y%m%d is the SQL spelling of "yyMMdd".
        Assert.Contains("DATE_FORMAT(`created_at`, '%y%m%d')", sql);
    }

    /// <summary>
    /// The migration must add the column BEFORE the unique index, with the backfill between
    /// them. Indexing first aborts the migration halfway on the first duplicate, leaving some
    /// orders numbered and some not.
    /// </summary>
    [Fact]
    public void The_backfill_runs_before_the_unique_index_is_created()
    {
        var migration = Directory
            .EnumerateFiles(MigrationsDirectory(), "*_AddOrderNumber.cs")
            .Single();

        var sql = File.ReadAllText(migration);

        var addColumn = sql.IndexOf("AddColumn", StringComparison.Ordinal);
        var backfill = sql.IndexOf("UPDATE `order`", StringComparison.Ordinal);
        var createIndex = sql.IndexOf("CreateIndex", StringComparison.Ordinal);

        Assert.True(addColumn >= 0 && backfill >= 0 && createIndex >= 0);
        Assert.True(
            addColumn < backfill && backfill < createIndex,
            "the migration must add the column, then backfill, then index — indexing before " +
            "the backfill aborts halfway on the first duplicate");
    }

    /// <summary>
    /// Walks up from the test binary to the migrations folder, so this does not depend on the
    /// working directory the runner happens to use.
    /// </summary>
    private static string MigrationsDirectory()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);

        while (directory is not null && directory.GetDirectories("src").Length == 0)
        {
            directory = directory.Parent;
        }

        Assert.NotNull(directory);
        return Path.Combine(
            directory!.FullName, "src", "Orders.Infrastructure", "Migrations");
    }
}
