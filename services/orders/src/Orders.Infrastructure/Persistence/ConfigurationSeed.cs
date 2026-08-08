using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Domain.Entities;

namespace Orders.Infrastructure.Persistence;

// Seeds baseline key/value configuration rows. Idempotent: each row is inserted
// only when its key is missing, so it is safe to run on every startup.
public static class ConfigurationSeed
{
    // Config key holding the order tax rate as a decimal string (e.g. "0.08").
    public const string TaxRateKey = "tax_rate";
    private const string DefaultTaxRate = "0.08";

    // Config key holding the flat per-order delivery charge, in CENTS ("1500" = $15.00).
    // Cents (not dollars) so it is read straight into the `long` the column stores, with
    // no decimal round trip. Lives here rather than in code so the rate can change
    // without a redeploy — the same reason tax_rate does.
    public const string ShippingCentsKey = "shipping_cents";
    private const string DefaultShippingCents = "1500";

    public static Task ApplyAsync(OrdersWriteDbContext db) =>
        // Stamp CreatedBy/UpdatedBy = orders_api:config_seed via the audit
        // interceptor (replaces the old bare "system" literal).
        AmbientActor.RunAsync(AuditActor.ConfigSeed, () => RunAsync(db));

    private static async Task RunAsync(OrdersWriteDbContext db)
    {
        // Each key is checked INDEPENDENTLY, not behind one early return on tax_rate.
        // A single guard would mean a database seeded before shipping_cents existed
        // (tax_rate already present) never receives the new key, and every order would
        // then fail on the missing-key exception.
        var added = false;
        added |= await SeedKeyAsync(db, TaxRateKey, DefaultTaxRate);
        added |= await SeedKeyAsync(db, ShippingCentsKey, DefaultShippingCents);

        if (added) await db.SaveChangesAsync();
    }

    private static async Task<bool> SeedKeyAsync(OrdersWriteDbContext db, string key, string value)
    {
        if (await db.Configurations.AnyAsync(c => c.Key == key)) return false;

        var now = DateTime.UtcNow;
        db.Configurations.Add(new Configuration
        {
            Key = key,
            Value = value,
            CreatedAt = now,
            UpdatedAt = now,
        });
        return true;
    }
}
