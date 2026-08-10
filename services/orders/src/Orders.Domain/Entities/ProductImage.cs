namespace Orders.Domain.Entities;

/// <summary>Display artwork for a catalogue product.</summary>
/// <remarks>
/// A record, not an entity: no Id, no table of its own, no audit fields. It is
/// embedded in the product row's <c>image</c> JSON column.
/// </remarks>
/// <param name="Uri">
/// Bucket key RELATIVE to the assets base URL, e.g. "products/runner-low-canvas.jpg".
/// NEVER absolute. Floci re-mints the bucket on every apply and <c>make clean</c>
/// destroys it, so an absolute URL persisted in a row is dead data after the next
/// rebuild — and it would bake an infrastructure detail into the domain. The API
/// composes the absolute form on read from ASSETS_BASE_URL.
/// </param>
/// <param name="Blurhash">
/// BlurHash placeholder (4x3 components) the client paints while the real image loads.
/// </param>
public record ProductImage(string Uri, int Width, int Height, string Blurhash);
