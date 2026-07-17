namespace Orders.Infrastructure.Id;

// Prefixed nano-ids, mirroring the shared convention: prd_ / ord_ / odd_.
public static class NanoId
{
    public const string ProductPrefix = "prd_";
    public const string OrderPrefix = "ord_";
    public const string OrderDetailPrefix = "odd_";

    // Nanoid 3.x exposes a synchronous Generate(alphabet, size). Use the default
    // URL-safe alphabet with the standard 21-char size.
    public static string NewId(string prefix) =>
        prefix + NanoidDotNet.Nanoid.Generate(NanoidDotNet.Nanoid.Alphabets.Default, 21);
}
