using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Orders.Application.Abstractions;
using Orders.Infrastructure.Persistence;

namespace Orders.Infrastructure.Config;

// Reads runtime configuration from the `configuration` table via the read
// DbContext (AsNoTracking), per call. Lives in Infrastructure because it touches
// EF Core; Application owns only the IConfigurationReader port.
public class ConfigurationReader : IConfigurationReader
{
    private readonly OrdersReadDbContext _db;

    public ConfigurationReader(OrdersReadDbContext db) => _db = db;

    public async Task<decimal> GetTaxRateAsync(CancellationToken ct = default)
    {
        var value = await _db.Configurations
            .AsNoTracking()
            .Where(c => c.Key == ConfigurationSeed.TaxRateKey)
            .Select(c => c.Value)
            .FirstOrDefaultAsync(ct)
            ?? throw new InvalidOperationException("tax_rate configuration missing");

        return decimal.Parse(value, CultureInfo.InvariantCulture);
    }
}
