using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Orders.Application.Orders;
using Orders.Domain.Entities;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Orders;
using Orders.Infrastructure.Persistence;
using Orders.Tests.Observability;
using Testcontainers.MySql;
using Xunit;

namespace Orders.Tests.Infrastructure;

// Proves the product catalog read side: GetProductsAsync maps active products to
// ProductDto and relies on the global query filter (ProductConfiguration:
// HasQueryFilter(p => p.DeletedAt == null)) to hide soft-deleted rows — no manual
// filter in ProductReadService itself.
public class ProductReadServiceTests : IAsyncLifetime
{
    // Stands in for ASSETS_BASE_URL. Rows store a bucket-relative key and the service
    // composes the absolute URL against this.
    private const string AssetsBaseUrl = "http://localhost:4566/bkt";

    private readonly MySqlContainer _mysql =
        new MySqlBuilder("mysql:8.0").WithDatabase("orders").Build();

    public Task InitializeAsync() => _mysql.StartAsync();
    public Task DisposeAsync() => _mysql.DisposeAsync().AsTask();

    private OrdersReadDbContext ReadCtx()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersReadDbContext(new DbContextOptionsBuilder<OrdersReadDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }

    private OrdersWriteDbContext WriteCtx()
    {
        var cs = _mysql.GetConnectionString();
        return new OrdersWriteDbContext(new DbContextOptionsBuilder<OrdersWriteDbContext>()
            .UseMySql(cs, ServerVersion.AutoDetect(cs)).Options);
    }

    [Fact]
    public async Task GetProductsAsync_returns_only_active_products_mapped_to_dto()
    {
        var now = DateTime.UtcNow;

        await using (var w = WriteCtx())
        {
            await w.Database.MigrateAsync();

            w.Products.Add(new Product
            {
                Id = "prd_active1",
                Name = "Widget",
                Description = "An active widget",
                UnitPriceCents = 1999,
                UnitsInStock = 42,
                CreatedAt = now,
                UpdatedAt = now,
            });

            // Soft-deleted product: DeletedAt set directly on the entity before
            // SaveChanges, so it is persisted as already-deleted (no interceptor
            // rewrite needed — this is a plain INSERT with deleted_at populated).
            w.Products.Add(new Product
            {
                Id = "prd_deleted1",
                Name = "Gadget",
                Description = "A soft-deleted gadget",
                UnitPriceCents = 999,
                UnitsInStock = 5,
                CreatedAt = now,
                UpdatedAt = now,
                DeletedAt = now,
            });

            await w.SaveChangesAsync();
        }

        await using var r = ReadCtx();
        // Inert without an ActivityListener — see OrderReadServiceTests.
        var svc = new ProductReadService(
            r, AssetsBaseUrl, new WorkflowTracer(), new SpanScopedLogger<ProductReadService>());

        var products = await svc.GetProductsAsync();

        var active = Assert.Single(products, p => p.Id == "prd_active1");
        Assert.Equal("Widget", active.Name);
        Assert.Equal("An active widget", active.Description);
        Assert.Equal(1999, active.UnitPrice.Cents);
        Assert.Equal("19.99", active.UnitPrice.Amount);
        Assert.Equal(42u, active.UnitsInStock);

        // Global query filter (ProductConfiguration.HasQueryFilter) must hide the
        // soft-deleted product from the read service — no manual filter needed.
        Assert.DoesNotContain(products, p => p.Id == "prd_deleted1");
    }

    // Seeds one product and returns its mapped DTO. Keeps the three artwork tests
    // below to their actual subject — the mapping — rather than repeating setup.
    private async Task<ProductDto> MapOneAsync(string name, string baseUrl, Product product)
    {
        await using (var w = WriteCtx())
        {
            await w.Database.MigrateAsync();
            w.Products.Add(product);
            await w.SaveChangesAsync();
        }

        await using var r = ReadCtx();
        var svc = new ProductReadService(
            r, baseUrl, new WorkflowTracer(), new SpanScopedLogger<ProductReadService>());
        return (await svc.GetProductsAsync()).Single(p => p.Name == name);
    }

    private static Product ProductWithImage(string id, string name, ProductImage? image,
        List<string>? categories = null) => new()
        {
            Id = id,
            Name = name,
            Description = "mapping subject",
            UnitPriceCents = 500,
            UnitsInStock = 3,
            Categories = categories ?? [],
            Image = image,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };

    [Fact]
    public async Task Maps_a_relative_uri_to_an_absolute_url()
    {
        var dto = await MapOneAsync("With Artwork", AssetsBaseUrl,
            ProductWithImage("prd_img1", "With Artwork",
                new ProductImage("products/field-tote-18l.jpg", 720, 1080, "LUEy0r"), ["BAGS"]));

        Assert.Equal("http://localhost:4566/bkt/products/field-tote-18l.jpg", dto.Image!.Uri);
        Assert.Equal(720, dto.Image.Width);
        Assert.Equal(1080, dto.Image.Height);
        Assert.Equal("LUEy0r", dto.Image.Blurhash);
        Assert.Equal(["BAGS"], dto.Categories);
    }

    [Fact]
    public async Task A_trailing_slash_on_the_base_url_does_not_double_up()
    {
        var dto = await MapOneAsync("Slashy", "http://localhost:4566/bkt/",
            ProductWithImage("prd_img2", "Slashy",
                new ProductImage("products/linen-cap.jpg", 720, 1080, "LA7KSX"), ["ACCESSORIES"]));

        Assert.Equal("http://localhost:4566/bkt/products/linen-cap.jpg", dto.Image!.Uri);
    }

    [Fact]
    public async Task A_product_without_an_image_maps_to_a_null_image_and_does_not_throw()
    {
        var dto = await MapOneAsync("Bare", AssetsBaseUrl,
            ProductWithImage("prd_img3", "Bare", image: null));

        Assert.Null(dto.Image);
        Assert.Empty(dto.Categories);
    }

    [Fact]
    public async Task GetProductsAsync_emits_the_list_products_workflow_span_with_the_catalogue_size()
    {
        await using (var w = WriteCtx())
        {
            await w.Database.MigrateAsync();
            w.Products.Add(ProductWithImage("prd_span1", "Spanny", image: null));
            await w.SaveChangesAsync();
        }

        // See OrderReadServiceTests: the listener must name this exact source or
        // the span is created and silently dropped.
        var recorded = new List<Activity>();
        using var listener = new ActivityListener
        {
            ShouldListenTo = source => source.Name == WorkflowTracer.ActivitySourceName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
            ActivityStopped = recorded.Add,
        };
        ActivitySource.AddActivityListener(listener);

        await using var r = ReadCtx();
        var logger = new SpanScopedLogger<ProductReadService>();
        var products = await new ProductReadService(r, AssetsBaseUrl, new WorkflowTracer(), logger)
            .GetProductsAsync();

        var span = Assert.Single(recorded);
        Assert.Equal("list_products", span.DisplayName);
        Assert.Equal(ActivityStatusCode.Ok, span.Status);
        // TagObjects, not Tags — see OrderReadServiceTests: an int-valued tag
        // never appears in Activity.Tags.
        Assert.Contains(span.TagObjects, t => t.Key == "product_count" && (int?)t.Value == products.Count);
        Assert.DoesNotContain(span.TagObjects, t => t.Key == "http.method" || t.Key == "http.route");
        Assert.NotEqual(default, span.Duration);

        // Exactly one line, carrying the flow's app_event and the same count the
        // span tag does — no _started twin (see OrderReadServiceTests for why a
        // read gets only the _succeeded half).
        var entry = Assert.Single(logger.Entries);
        Assert.Equal(LogLevel.Information, entry.Level);
        Assert.Equal("list_products_succeeded", entry.Values["app_event"]);
        Assert.Equal(products.Count, entry.Values["product_count"]);

        // The point of the line: written while THIS span is the ambient activity,
        // so LogContextEnricher stamps this span's id on it and a span-scoped log
        // lookup resolves. A line outside the activity would pass every other
        // assertion here and still leave the span mute.
        Assert.Same(span, entry.Activity);
    }
}
