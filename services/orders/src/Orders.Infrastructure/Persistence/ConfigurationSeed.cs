using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;

namespace Orders.Infrastructure.Persistence;

// Seeds baseline key/value configuration rows. Idempotent: each row is inserted
// only when its key is missing, so it is safe to run on every startup.
public static class ConfigurationSeed
{
    // Config key holding the order tax rate as a decimal string (e.g. "0.08").
    public const string TaxRateKey = "tax_rate";
    private const string DefaultTaxRate = "0.08";

    public static async Task ApplyAsync(OrdersWriteDbContext db)
    {
        if (await db.Configurations.AnyAsync(c => c.Key == TaxRateKey)) return;

        var now = DateTime.UtcNow;
        db.Configurations.Add(new Configuration
        {
            Key = TaxRateKey,
            Value = DefaultTaxRate,
            CreatedBy = "system",
            CreatedAt = now,
            UpdatedAt = now,
        });
        await db.SaveChangesAsync();
    }
}
