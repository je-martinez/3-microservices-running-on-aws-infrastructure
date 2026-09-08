namespace Orders.Application.Abstractions;

// Read-side port for runtime configuration. The tax rate now lives in the
// `configuration` table (key `tax_rate`) instead of an env var, and is read
// per-request so it can change without a redeploy.
public interface IConfigurationReader
{
    Task<decimal> GetTaxRateAsync(CancellationToken ct = default);

    /// <summary>
    /// The flat delivery charge applied to an order, in CENTS (key <c>shipping_cents</c>).
    /// </summary>
    /// <remarks>
    /// CONTRACT: Returns <c>long</c>, never <c>decimal</c> — a decimal reintroduces the
    /// rounding step integer cents exist to avoid. See [[money-representation]]
    /// </remarks>
    Task<long> GetShippingCentsAsync(CancellationToken ct = default);
}
