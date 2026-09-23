using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Orders.Application.Orders;
using Orders.Domain.Entities;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Orders;
using Orders.Tests.Observability;
using Orders.Tests.Payments;
using Stripe;
using Product = Orders.Domain.Entities.Product;

namespace Orders.Tests.Api;

/// <summary>
/// POST /v1/orders with the Stripe flag on and off, against a REAL <see cref="StripeClient"/>
/// whose transport is <see cref="FakeStripeHandler"/>.
/// </summary>
[Collection(OrdersApiCollection.Name)]
public partial class CreateOrderStripeTests : IAsyncLifetime
{
    private const string PaymentMethodId = FakeStripeHandler.PaymentMethodId;

    private readonly OrdersApiFactory _factory;
    private string _productId = string.Empty;

    public CreateOrderStripeTests(OrdersApiFactory factory) => _factory = factory;

    // WHY: A product of its own with deep stock — the factory's shared product has 5 units
    // spread over every test class in the collection.
    public async Task InitializeAsync()
    {
        await using var db = _factory.NewWriteContext();
        _productId = NanoId.NewId(NanoId.ProductPrefix);
        db.Products.Add(new Product
        {
            Id = _productId,
            Name = "Stripe Widget",
            Description = "d",
            UnitPriceCents = 2500,
            UnitsInStock = 1000,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task CreateOrder_WithStripeEnabledAndNoPaymentMethodId_Returns400()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripeEnabled: true, stripe);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(stripe.Requests);
    }

    [Fact]
    public async Task CreateOrder_WithStripeDisabled_IgnoresPaymentMethodIdAndSucceeds()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripeEnabled: false, stripe);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
            paymentMethodId = PaymentMethodId,
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Empty(stripe.Requests);
        var dto = await response.Content.ReadFromJsonAsync<OrderDto>();
        var order = await LoadOrderAsync(dto!.Id);
        Assert.NotNull(order);
        Assert.Null(order!.PaymentIntentId);
        Assert.Null(order.PaymentRawPayload);
    }

    [Fact]
    public async Task CreateOrder_WithStripeEnabled_ChargesOffSessionBeforePersistingAndStoresTheSnapshot()
    {
        var stockBefore = await StockAsync();
        var stripe = FakeStripeHandler.Succeeding();
        bool? orderRowExistedDuringCharge = null;
        bool? productRowLockableDuringCharge = null;
        stripe.OnRequest = async request =>
        {
            // WHY: Observed from ANOTHER connection while the charge is in flight. A committed
            // row here means the order was persisted before it was paid for; a held lock
            // means the charge runs inside the stock transaction.
            var orderId = request.Form["metadata[order_id]"].ToString();
            await using var db = _factory.NewWriteContext();
            orderRowExistedDuringCharge = await db.Orders
                .IgnoreQueryFilters().AnyAsync(o => o.Id == orderId);
            await using var tx = await db.Database.BeginTransactionAsync();
            productRowLockableDuringCharge = await db.Database
                .SqlQueryRaw<string>("SELECT id AS Value FROM product WHERE id = {0} FOR UPDATE NOWAIT", _productId)
                .AnyAsync();
        };
        var client = ClientFor(stripeEnabled: true, stripe);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 2 } },
            paymentMethodId = PaymentMethodId,
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var dto = (await response.Content.ReadFromJsonAsync<OrderDto>())!;

        var request = Assert.Single(stripe.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("/v1/payment_intents", request.Path);
        Assert.Equal("true", request.Form["off_session"]);
        Assert.Equal("true", request.Form["confirm"]);
        Assert.Equal(dto.Total.Cents.ToString(), request.Form["amount"]);
        Assert.Equal("usd", request.Form["currency"]);
        Assert.Equal(OrdersApiFactory.KnownStripeCustomerId, request.Form["customer"]);
        Assert.Equal(PaymentMethodId, request.Form["payment_method"]);
        // CONTRACT: Expanding payment_method needs PaymentMethods read, which Orders' restricted
        // key must not have — the card details come from the charge instead.
        var expanded = request.Form.Where(f => f.Key.StartsWith("expand", StringComparison.Ordinal))
            .SelectMany(f => f.Value.ToArray()).ToArray();
        Assert.Equal(new[] { "latest_charge" }, expanded);
        Assert.DoesNotContain(request.Form.Keys, k => k.StartsWith("payment_method_types", StringComparison.Ordinal));
        Assert.Equal(dto.Id, request.Form["metadata[order_id]"]);
        Assert.Equal(ChargeKeyOf(client), request.IdempotencyKey);
        Assert.Equal("2026-08-26.dahlia", request.StripeVersion);

        Assert.False(orderRowExistedDuringCharge);
        Assert.True(productRowLockableDuringCharge);

        var order = (await LoadOrderAsync(dto.Id))!;
        Assert.Equal(FakeStripeHandler.PaymentIntentId, order.PaymentIntentId);
        Assert.Equal("succeeded", order.PaymentStatus);
        Assert.Equal(dto.Total.Cents, order.AmountCents);
        Assert.Equal("usd", order.Currency);
        Assert.Equal(PaymentMethodId, order.PaymentMethodId);
        Assert.Equal(FakeStripeHandler.ChargeCardBrand, order.CardBrand);
        Assert.Equal(FakeStripeHandler.ChargeCardLast4, order.CardLast4);
        Assert.Equal(FakeStripeHandler.ChargeCardExpMonth, order.CardExpMonth);
        Assert.Equal(FakeStripeHandler.ChargeCardExpYear, order.CardExpYear);
        Assert.Contains(FakeStripeHandler.PaymentIntentId, order.PaymentRawPayload);
        Assert.DoesNotContain("client_secret", order.PaymentRawPayload);
        Assert.Equal(stockBefore - 2, await StockAsync());
    }

    [Fact]
    public async Task CreateOrder_WhenTheCardIsDeclined_Returns402WithStripesMessageAndPersistsNothing()
    {
        var stockBefore = await StockAsync();
        var stripe = FakeStripeHandler.Declining();
        var client = ClientFor(stripeEnabled: true, stripe);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
            paymentMethodId = PaymentMethodId,
        });

        Assert.Equal(HttpStatusCode.PaymentRequired, response.StatusCode);
        var body = (await response.Content.ReadFromJsonAsync<PaymentErrorBody>())!;
        Assert.Equal("payment_declined", body.Error);
        Assert.Equal("Your card has insufficient funds.", body.Detail);
        Assert.Equal("card_declined", body.Code);

        var orderId = Assert.Single(stripe.Requests).Form["metadata[order_id]"].ToString();
        Assert.Null(await LoadOrderAsync(orderId));
        Assert.Equal(stockBefore, await StockAsync());
    }

    [Fact]
    public async Task CreateOrder_WhenTheCardIsDeclined_DoesNotMarkTheWorkflowSpanAsError()
    {
        var stopped = new List<Activity>();
        using var listener = new ActivityListener
        {
            ShouldListenTo = s => s.Name is WorkflowTracer.ActivitySourceName or StripeActivitySource.Name,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
            ActivityStopped = a => { lock (stopped) { stopped.Add(a); } },
        };
        ActivitySource.AddActivityListener(listener);
        var stripe = FakeStripeHandler.Declining();
        var client = ClientFor(stripeEnabled: true, stripe);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
            paymentMethodId = PaymentMethodId,
        });

        Assert.Equal(HttpStatusCode.PaymentRequired, response.StatusCode);
        var orderId = Assert.Single(stripe.Requests).Form["metadata[order_id]"].ToString();
        Activity[] spans;
        lock (stopped) { spans = stopped.ToArray(); }

        // WHY: Other test classes run in parallel and emit their own create_order spans, so the
        // workflow span is found as the PARENT of this request's Stripe span, not by name.
        var charge = Assert.Single(spans, a =>
            a.Source.Name == StripeActivitySource.Name
            && (string?)a.GetTagItem("stripe.idempotency_key") == ChargeKeyOf(client));
        Assert.Equal(ActivityStatusCode.Error, charge.Status);
        var workflow = Assert.Single(spans, a => a.SpanId == charge.ParentSpanId);
        Assert.Equal("create_order", workflow.DisplayName);
        Assert.NotEqual(ActivityStatusCode.Error, workflow.Status);
        Assert.Equal("payment_declined", workflow.GetTagItem("app_event"));
        Assert.Equal("insufficient_funds", workflow.GetTagItem("reason"));
    }

    [Fact]
    public async Task CreateOrder_WhenStripeRejectsTheKey_Returns503WithoutEchoingStripesMessage()
    {
        var stripe = FakeStripeHandler.RejectingTheKey();
        var client = ClientFor(stripeEnabled: true, stripe);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
            paymentMethodId = PaymentMethodId,
        });

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var raw = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("rk_", raw);
        Assert.DoesNotContain("API Key", raw);
        var orderId = Assert.Single(stripe.Requests).Form["metadata[order_id]"].ToString();
        Assert.Null(await LoadOrderAsync(orderId));
    }

    [Fact]
    public async Task CreateOrder_WithStripeEnabledAndNoKey_Returns503AndPersistsNothing()
    {
        var stockBefore = await StockAsync();
        var client = ClientFor(stripeEnabled: true, stripe: null);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
            paymentMethodId = PaymentMethodId,
        });

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal(stockBefore, await StockAsync());
    }

    [Fact]
    public async Task CreateOrder_ForACallerWithNoStripeCustomer_Returns402WithoutCallingStripe()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripeEnabled: true, stripe, OrdersApiFactory.OtherCognitoSub);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
            paymentMethodId = PaymentMethodId,
        });

        Assert.Equal(HttpStatusCode.PaymentRequired, response.StatusCode);
        Assert.Empty(stripe.Requests);
    }

    [Fact]
    public async Task CreateOrder_WithStripeEnabledAndTooLittleStock_Returns409WithoutCharging()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripeEnabled: true, stripe);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 100_000 } },
            paymentMethodId = PaymentMethodId,
        });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Empty(stripe.Requests);
    }

    [Theory]
    [InlineData("unknown_brand_xyz", "4242", 12, 2099, false)] // unknown brand rejected server-side
    [InlineData("visa", "42", 12, 2099, false)]                // last4 not exactly 4 digits
    [InlineData("visa", "4242", 1, 2020, false)]               // expired
    [InlineData("visa", "4242", 12, 2099, true)]               // valid
    public async Task CreateOrder_ValidatesCardMetadata_WhenStripeDisabled(
        string brand, string last4, int expMonth, int expYear, bool expectSuccess)
    {
        var client = ClientFor(stripeEnabled: false, stripe: null);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
            card = new { brand, last4, expMonth, expYear },
        });

        Assert.Equal(expectSuccess ? HttpStatusCode.Created : HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task CreateOrder_RejectsCardMetadataWithAMissingField_WhenStripeDisabled()
    {
        var client = ClientFor(stripeEnabled: false, stripe: null);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
            card = new { brand = "visa", last4 = "4242", expMonth = 12 },
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task CreateOrder_IgnoresCardMetadata_WhenStripeEnabled()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripeEnabled: true, stripe);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
            paymentMethodId = PaymentMethodId,
            card = new { brand = "unknown_brand_xyz", last4 = "42", expMonth = 1, expYear = 2020 },
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }

    private HttpClient ClientFor(
        bool stripeEnabled,
        FakeStripeHandler? stripe,
        string sub = OrdersApiFactory.KnownCognitoSub,
        SpanScopedLogger<CreateOrderService>? serviceLog = null)
    {
        var host = _factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("STRIPE_ENABLED", stripeEnabled ? "true" : "false");
            if (serviceLog is not null)
            {
                builder.ConfigureTestServices(services =>
                    services.AddSingleton<ILogger<CreateOrderService>>(serviceLog));
            }

            if (stripe is null)
            {
                return;
            }

            builder.UseSetting("STRIPE_SECRET_KEY", "rk_test_fake");
            builder.ConfigureTestServices(services =>
            {
                foreach (var d in services.Where(d => d.ServiceType == typeof(IStripeClient)).ToList())
                {
                    services.Remove(d);
                }

                services.AddSingleton(FakeStripeHandler.ClientFor(stripe));
            });
        });

        var client = host.CreateClient();
        client.DefaultRequestHeaders.Add("x-user-id", sub);
        if (stripeEnabled)
        {
            client.DefaultRequestHeaders.Add(IdempotencyHeader, Guid.NewGuid().ToString());
        }

        return client;
    }

    private const string IdempotencyHeader = "Idempotency-Key";

    private static string KeyOf(HttpClient client) =>
        client.DefaultRequestHeaders.GetValues(IdempotencyHeader).Single();

    /// <summary>The Stripe charge key for the known caller and this client's Idempotency-Key.</summary>
    private static string ChargeKeyOf(HttpClient client) =>
        $"order-charge-{OrdersApiFactory.KnownUserId}-{KeyOf(client)}";

    private async Task<Order?> LoadOrderAsync(string orderId)
    {
        await using var db = _factory.NewWriteContext();
        return await db.Orders.AsNoTracking().IgnoreQueryFilters().SingleOrDefaultAsync(o => o.Id == orderId);
    }

    private async Task<uint> StockAsync()
    {
        await using var db = _factory.NewWriteContext();
        return (await db.Products.AsNoTracking().SingleAsync(p => p.Id == _productId)).UnitsInStock;
    }

    private sealed record PaymentErrorBody(string Error, string Detail, string? Code);
}
