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
    /// Returns <c>long</c>, not <c>decimal</c>: this is a money amount, and money is stored
    /// and moved as integer cents in this service (see the stack notes). A decimal here
    /// would reintroduce the rounding step the cents representation exists to avoid.
    /// </remarks>
    Task<long> GetShippingCentsAsync(CancellationToken ct = default);
}
