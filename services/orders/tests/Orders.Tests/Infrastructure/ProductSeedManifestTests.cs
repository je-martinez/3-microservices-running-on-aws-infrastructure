using System.Text.Json;
using Orders.Infrastructure.Persistence;
using Xunit;

namespace Orders.Tests.Infrastructure;

/// <summary>
/// Cross-checks the seed's embedded image metadata against assets.manifest.json.
/// </summary>
/// <remarks>
/// <para>
/// The seed hardcodes each product's width/height/blurhash rather than reading the
/// manifest at runtime (which would mean mounting it into the container and adding a
/// boot-time failure mode for a file <c>make bootstrap</c> does not guarantee exists).
/// This test is what makes that safe: re-run <c>make assets-sync</c> after changing a
/// photo and this fails until the seed is updated to match.
/// </para>
/// <para>
/// Note the values describe the OPTIMISED objects, not the masters under
/// assets/products/ — sync_assets.py caps the long edge at 1080, so a 1080x1620 master
/// is served as 720x1080. The manifest is the authority precisely because it records
/// what was uploaded.
/// </para>
/// <para>
/// This project is on xUnit 2.9.3, which has NO runtime skip (Assert.Skip is a v3 API),
/// so an absent or un-synced manifest returns early instead: a fresh clone that has
/// never run the sync must not fail the suite for an unrelated reason. The trade-off is
/// that such a run reads as PASSED rather than SKIPPED, which is why the local
/// verification step runs this again after `make assets-sync`.
/// </para>
/// </remarks>
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
