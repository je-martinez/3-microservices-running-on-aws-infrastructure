using System.Text.Json;
using Orders.Infrastructure.Persistence;
using Xunit;

namespace Orders.Tests.Infrastructure;

/// <summary>
/// Cross-checks the seed's embedded image metadata against assets.manifest.json.
/// CONTRACT: This is what makes hardcoding that metadata safe — after <c>make assets-sync</c>
/// it fails until the seed matches. The values describe the OPTIMISED objects, not the
/// masters.
/// WARNING: xUnit 2.9.3 has no runtime skip, so an absent manifest returns EARLY and the run
/// reads as PASSED rather than SKIPPED. See [[testing]]
/// </summary>
public class ProductSeedManifestTests
{
    private static string? FindManifest()
    {
        // Walk up from the test binary to the repo root. The test runs from
        // tests/Orders.Tests/bin/<config>/<tfm>/, so the depth is not fixed across
        // configurations — search rather than counting parents.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "assets", "assets.manifest.json");
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        return null;
    }

    [Fact]
    public void Seed_image_metadata_matches_the_assets_manifest()
    {
        var path = FindManifest();
        if (path is null) return;   // never synced; see the remarks above

        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        if (!doc.RootElement.TryGetProperty("assets", out var assets)) return;

        var products = assets.EnumerateObject()
            .Where(p => p.Name.StartsWith("products/", StringComparison.Ordinal))
            .ToDictionary(p => p.Name, p => p.Value);

        if (products.Count == 0) return;

        foreach (var image in ProductSeed.SeedImages)
        {
            Assert.True(products.ContainsKey(image.Uri),
                $"seed references {image.Uri}, which the manifest does not contain — "
                + "the file is missing from assets/products/ or the sync did not run.");

            var entry = products[image.Uri];
            Assert.Equal(image.Width, entry.GetProperty("width").GetInt32());
            Assert.Equal(image.Height, entry.GetProperty("height").GetInt32());
            Assert.Equal(image.Blurhash, entry.GetProperty("blurhash").GetString());
        }
    }
}
