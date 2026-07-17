namespace Orders.Application.Abstractions;

// Read-side port for runtime configuration. The tax rate now lives in the
// `configuration` table (key `tax_rate`) instead of an env var, and is read
// per-request so it can change without a redeploy.
public interface IConfigurationReader
{
    Task<decimal> GetTaxRateAsync(CancellationToken ct = default);
}
