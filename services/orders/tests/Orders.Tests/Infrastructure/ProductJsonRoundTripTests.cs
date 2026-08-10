using Microsoft.EntityFrameworkCore;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Persistence;
using Testcontainers.MySql;
using Xunit;

namespace Orders.Tests.Infrastructure;

// Persistence-level guard for the product table's two JSON columns (`image`,
// `categories`). Uses a real MySQL container, not a mock: the whole point is to prove
// the converters and comparers behave against the actual driver, which an in-memory
// fake cannot show.
public class ProductJsonRoundTripTests : IAsyncLifetime
{
    private readonly MySqlContainer _mysql =
        new MySqlBuilder("mysql:8.0").WithDatabase("orders").Build();

    public Task InitializeAsync() => _mysql.StartAsync();
    public Task DisposeAsync() => _mysql.DisposeAsync().AsTask();

    private OrdersWriteDbContext WriteCtx()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersWriteDbContext(new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }

    private static Product NewProduct() => new()
    {
        Id = NanoId.NewId(NanoId.ProductPrefix),
        Name = "Round Trip",
        Description = "Persisted through a real driver",
        UnitPriceCents = 1234,
        UnitsInStock = 7,
        Categories = ["FOOTWEAR", "OUTERWEAR"],
        Image = new ProductImage("products/round-trip.jpg", 1080, 720, "LWMj?rRjD%of"),
        CreatedAt = DateTime.UtcNow,
        UpdatedAt = DateTime.UtcNow,
    };

    [Fact]
    public async Task Image_and_categories_survive_a_write_then_a_fresh_read()
    {
        await using (var db = WriteCtx())
        {
            await db.Database.MigrateAsync();
            db.Products.Add(NewProduct());
            await db.SaveChangesAsync();
        }

        // A FRESH context: the first one's change tracker would happily return the
        // in-memory object even if nothing reached the database.
        await using var read = WriteCtx();
        var loaded = await read.Products.SingleAsync(p => p.Name == "Round Trip");

        Assert.Equal(["FOOTWEAR", "OUTERWEAR"], loaded.Categories);
        Assert.NotNull(loaded.Image);
        Assert.Equal("products/round-trip.jpg", loaded.Image!.Uri);
        Assert.Equal(1080, loaded.Image.Width);
        Assert.Equal(720, loaded.Image.Height);
        Assert.Equal("LWMj?rRjD%of", loaded.Image.Blurhash);
    }

    [Fact]
    public async Task Mutating_the_categories_list_is_detected_and_persisted()
    {
        // THE ValueComparer TEST. Without a structural comparer EF compares
        // List<string> by reference, sees no change, and silently skips the UPDATE —
        // this test fails while every other test still passes.
        string id;
        await using (var db = WriteCtx())
        {
            await db.Database.MigrateAsync();
            var p = NewProduct();
            id = p.Id;
            db.Products.Add(p);
            await db.SaveChangesAsync();
        }

        await using (var db = WriteCtx())
        {
            var p = await db.Products.SingleAsync(x => x.Id == id);
            p.Categories.Add("BAGS");          // mutate IN PLACE, no reassignment
            await db.SaveChangesAsync();
        }

        await using var verify = WriteCtx();
        var reloaded = await verify.Products.SingleAsync(x => x.Id == id);
        Assert.Equal(["FOOTWEAR", "OUTERWEAR", "BAGS"], reloaded.Categories);
    }

    [Fact]
    public async Task A_product_without_an_image_reads_back_as_null_and_empty()
    {
        await using (var db = WriteCtx())
        {
            await db.Database.MigrateAsync();
            var p = NewProduct();
            p.Name = "No Artwork";
            p.Image = null;
            p.Categories = [];
            db.Products.Add(p);
            await db.SaveChangesAsync();
        }

        await using var read = WriteCtx();
        var loaded = await read.Products.SingleAsync(p => p.Name == "No Artwork");
        Assert.Null(loaded.Image);
        Assert.Empty(loaded.Categories);
    }
}
