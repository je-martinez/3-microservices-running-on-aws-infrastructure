namespace Orders.Domain.Entities;

/// <summary>
/// Display artwork for a catalogue product. A record, not an entity — embedded in the product
/// row's <c>image</c> JSON column. <c>Blurhash</c> is the 4x3 placeholder the client paints
/// while the real image loads.
/// CONTRACT: <c>Uri</c> is a bucket key RELATIVE to the assets base URL, NEVER absolute —
/// Floci re-mints the bucket on every apply, so a stored absolute URL is dead data after the
/// next rebuild. See [[ADR-0017-floci-local]]
/// </summary>
public record ProductImage(string Uri, int Width, int Height, string Blurhash);
