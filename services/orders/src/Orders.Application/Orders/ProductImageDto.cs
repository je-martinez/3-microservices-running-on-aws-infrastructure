namespace Orders.Application.Orders;

/// <summary>Wire shape for a product's artwork.</summary>
/// <param name="Uri">
/// ABSOLUTE URL, composed by ProductReadService from the assets base URL and the
/// bucket-relative key stored on the row. The client fetches this directly.
/// </param>
/// <param name="Blurhash">BlurHash placeholder to paint while the image loads.</param>
public record ProductImageDto(string Uri, int Width, int Height, string Blurhash);
