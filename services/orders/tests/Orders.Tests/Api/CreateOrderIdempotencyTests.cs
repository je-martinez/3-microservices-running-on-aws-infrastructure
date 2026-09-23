using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Orders.Application.Orders;
using Orders.Infrastructure.Id;
using Orders.Infrastructure.Orders;
using Orders.Tests.Observability;
using Orders.Tests.Payments;
using Product = Orders.Domain.Entities.Product;

namespace Orders.Tests.Api;

/// <summary>
/// The client-supplied <c>Idempotency-Key</c> on POST /v1/orders, one branch per test.
/// See [[2026-09-19-stripe-payments-design]]
/// </summary>
public partial class CreateOrderStripeTests
{
    [Fact]
    public async Task CreateOrder_WithStripeEnabledAndNoIdempotencyKey_Returns400WithoutCallingStripe()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripeEnabled: true, stripe);
        client.DefaultRequestHeaders.Remove(IdempotencyHeader);

        var response = await client.PostAsJsonAsync("/v1/orders", OneLine());

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("idempotency_key_required", (await response.Content.ReadFromJsonAsync<ErrorBody>())!.Error);
        Assert.Empty(stripe.Requests);
    }

    [Theory]
    [InlineData(65)]   // over the 64-character limit
    [InlineData(0)]    // blank
    public async Task CreateOrder_WithStripeEnabledAndAnInvalidIdempotencyKey_Returns400(int length)
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripeEnabled: true, stripe);
        client.DefaultRequestHeaders.Remove(IdempotencyHeader);
        client.DefaultRequestHeaders.TryAddWithoutValidation(IdempotencyHeader, new string('k', length));

        var response = await client.PostAsJsonAsync("/v1/orders", OneLine());

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(stripe.Requests);
    }

    [Fact]
    public async Task CreateOrder_WithStripeDisabled_IgnoresTheIdempotencyKey()
    {
        var client = ClientFor(stripeEnabled: false, stripe: null);
        client.DefaultRequestHeaders.Add(IdempotencyHeader, "same-key");

        var first = await client.PostAsJsonAsync("/v1/orders", OneLine());
        var second = await client.PostAsJsonAsync("/v1/orders", OneLine());

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);
        var firstOrder = (await first.Content.ReadFromJsonAsync<OrderDto>())!;
        Assert.Null((await LoadOrderAsync(firstOrder.Id))!.IdempotencyKey);
    }

    [Fact]
    public async Task CreateOrder_RepeatedWithTheSameKey_ReturnsTheExistingOrderWithoutChargingAgain()
    {
        var stockBefore = await StockAsync();
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripeEnabled: true, stripe);

        var first = await client.PostAsJsonAsync("/v1/orders", OneLine());
        var second = await client.PostAsJsonAsync("/v1/orders", OneLine());

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.Equal(await first.Content.ReadAsStringAsync(), await second.Content.ReadAsStringAsync());
        Assert.Single(stripe.Charges);
        Assert.Equal(stockBefore - 1, await StockAsync());
        var order = (await LoadOrderAsync((await first.Content.ReadFromJsonAsync<OrderDto>())!.Id))!;
        Assert.Equal(KeyOf(client), order.IdempotencyKey);
    }

    [Fact]
    public async Task CreateOrder_FiredConcurrentlyWithTheSameKey_PersistsOneOrderAndChargesOnce()
    {
        var stockBefore = await StockAsync();
        var stripe = FakeStripeHandler.Succeeding();
        // WHY: Holds the first charge until the duplicate reaches Stripe too, so BOTH requests
        // pass the pre-charge lookup and race on the insert.
        var bothCharging = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var arrivals = 0;
        stripe.OnRequest = async _ =>
        {
            if (Interlocked.Increment(ref arrivals) == 2)
            {
                bothCharging.SetResult();
            }

            await bothCharging.Task.WaitAsync(TimeSpan.FromSeconds(10));
        };
        var client = ClientFor(stripeEnabled: true, stripe);

        var responses = await Task.WhenAll(
            client.PostAsJsonAsync("/v1/orders", OneLine()),
            client.PostAsJsonAsync("/v1/orders", OneLine()));

        Assert.Equal(2, stripe.Charges.Count());
        Assert.Equal(1, stripe.ChargesExecuted);
        Assert.Empty(stripe.Refunds);
        Assert.Equal(
            new[] { HttpStatusCode.OK, HttpStatusCode.Created },
            responses.Select(r => r.StatusCode).OrderBy(s => s));
        var bodies = await Task.WhenAll(responses.Select(r => r.Content.ReadFromJsonAsync<OrderDto>()));
        Assert.Equal(bodies[0]!.Id, bodies[1]!.Id);
        await using var db = _factory.NewWriteContext();
        Assert.Equal(1, await db.Orders.IgnoreQueryFilters().CountAsync(o => o.IdempotencyKey == KeyOf(client)));
        Assert.Equal(stockBefore - 1, await StockAsync());
    }

    [Fact]
    public async Task CreateOrder_RetriedWithAKeyWhoseChargeWasRefunded_Returns409AndPersistsNothing()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var drain = true;
        stripe.OnRequest = async _ =>
        {
            if (drain)
            {
                await ChangeProductMidChargeAsync("UPDATE product SET units_in_stock = 0 WHERE id = {0}");
            }
        };
        var client = ClientFor(stripeEnabled: true, stripe);
        var first = await client.PostAsJsonAsync("/v1/orders", OneLine());
        Assert.Equal(HttpStatusCode.Conflict, first.StatusCode);
        drain = false;
        await ChangeProductMidChargeAsync("UPDATE product SET units_in_stock = 1000 WHERE id = {0}");

        var retry = await client.PostAsJsonAsync("/v1/orders", OneLine());

        Assert.Equal(HttpStatusCode.Conflict, retry.StatusCode);
        Assert.Equal("idempotency_key_reused", (await retry.Content.ReadFromJsonAsync<ErrorBody>())!.Error);
        Assert.Equal(1, stripe.ChargesExecuted);
        Assert.Equal(1, stripe.RefundsExecuted);
        await using var db = _factory.NewWriteContext();
        Assert.False(await db.Orders.IgnoreQueryFilters().AnyAsync(o => o.IdempotencyKey == KeyOf(client)));
    }

    [Fact]
    public async Task CreateOrder_RetriedWithTheSameKeyAndADifferentBody_Returns422()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var drain = true;
        stripe.OnRequest = async _ =>
        {
            if (drain)
            {
                await ChangeProductMidChargeAsync("UPDATE product SET units_in_stock = 0 WHERE id = {0}");
            }
        };
        var client = ClientFor(stripeEnabled: true, stripe);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/v1/orders", OneLine())).StatusCode);
        drain = false;
        await ChangeProductMidChargeAsync("UPDATE product SET units_in_stock = 1000 WHERE id = {0}");

        var retry = await client.PostAsJsonAsync("/v1/orders", OneLine(quantity: 2));

        Assert.Equal(HttpStatusCode.UnprocessableEntity, retry.StatusCode);
        Assert.Equal("idempotency_key_mismatch", (await retry.Content.ReadFromJsonAsync<ErrorBody>())!.Error);
        Assert.Equal(1, stripe.ChargesExecuted);
    }

    [Fact]
    public async Task CreateOrder_ReplayedWithTheSameKeyAndDifferentItems_Returns422WithoutCallingStripe()
    {
        var stockBefore = await StockAsync();
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripeEnabled: true, stripe);
        Assert.Equal(HttpStatusCode.Created, (await client.PostAsJsonAsync("/v1/orders", OneLine())).StatusCode);

        var replay = await client.PostAsJsonAsync("/v1/orders", OneLine(quantity: 2));

        Assert.Equal(HttpStatusCode.UnprocessableEntity, replay.StatusCode);
        Assert.Equal("idempotency_key_mismatch", (await replay.Content.ReadFromJsonAsync<ErrorBody>())!.Error);
        Assert.Single(stripe.Requests);
        Assert.Equal(stockBefore - 1, await StockAsync());
    }

    [Fact]
    public async Task CreateOrder_ReplayedWithTheSameKeyAndAnotherPaymentMethod_Returns422WithoutCallingStripe()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripeEnabled: true, stripe);
        Assert.Equal(HttpStatusCode.Created, (await client.PostAsJsonAsync("/v1/orders", OneLine())).StatusCode);

        var replay = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
            paymentMethodId = "pm_card_mastercard",
        });

        Assert.Equal(HttpStatusCode.UnprocessableEntity, replay.StatusCode);
        Assert.Equal("idempotency_key_mismatch", (await replay.Content.ReadFromJsonAsync<ErrorBody>())!.Error);
        Assert.Single(stripe.Requests);
    }

    [Fact]
    public async Task CreateOrder_ReplayedWithTheSameItemsInAnotherOrder_ReturnsTheExistingOrder()
    {
        var otherProductId = await AddProductAsync();
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripeEnabled: true, stripe);

        var first = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 }, new { productId = otherProductId, quantity = 2 } },
            paymentMethodId = PaymentMethodId,
        });
        var replay = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = otherProductId, quantity = 2 }, new { productId = _productId, quantity = 1 } },
            paymentMethodId = PaymentMethodId,
        });

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        Assert.Equal(await first.Content.ReadAsStringAsync(), await replay.Content.ReadAsStringAsync());
        Assert.Single(stripe.Charges);
    }

    [Fact]
    public async Task CreateOrder_ReplayedAgainstAnOrderWithNoRequestHash_ReturnsTheExistingOrder()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripeEnabled: true, stripe);
        var first = await client.PostAsJsonAsync("/v1/orders", OneLine());
        var orderId = (await first.Content.ReadFromJsonAsync<OrderDto>())!.Id;
        var stored = (await LoadOrderAsync(orderId))!;
        Assert.Matches("^[0-9a-f]{64}$", stored.IdempotencyRequestHash);
        await using (var db = _factory.NewWriteContext())
        {
            await db.Database.ExecuteSqlRawAsync(
                "UPDATE `order` SET idempotency_request_hash = NULL WHERE id = {0}", orderId);
        }

        var replay = await client.PostAsJsonAsync("/v1/orders", OneLine(quantity: 2));

        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        Assert.Equal(orderId, (await replay.Content.ReadFromJsonAsync<OrderDto>())!.Id);
        Assert.Single(stripe.Charges);
    }

    [Fact]
    public async Task CreateOrder_DuplicateStripeRejectsAsInFlight_ReturnsTheWinnersOrderOnceItCommits()
    {
        var stripe = FakeStripeHandler.RejectingInFlightRepeats();
        var arrivals = 0;
        stripe.OnRequest = async _ =>
        {
            if (Interlocked.Increment(ref arrivals) == 1)
            {
                await stripe.InFlightConflictAnswered.WaitAsync(TimeSpan.FromSeconds(10));
            }
        };
        var log = new SpanScopedLogger<CreateOrderService>();
        var client = ClientFor(stripeEnabled: true, stripe, serviceLog: log);

        var winner = client.PostAsJsonAsync("/v1/orders", OneLine());
        await UntilAsync(() => stripe.Charges.Count() == 1);
        var duplicate = await client.PostAsJsonAsync("/v1/orders", OneLine());
        var created = await winner;

        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        Assert.Equal(HttpStatusCode.OK, duplicate.StatusCode);
        Assert.Equal(await created.Content.ReadAsStringAsync(), await duplicate.Content.ReadAsStringAsync());
        Assert.Equal(1, stripe.ChargesExecuted);
        Assert.Empty(stripe.Refunds);
        Assert.DoesNotContain(log.Entries.ToArray(), e => e.Level >= LogLevel.Error);
    }

    [Fact]
    public async Task CreateOrder_DuplicateStripeRejectsAsInFlight_Returns503WithRetryAfterWhenNoOrderAppears()
    {
        var stripe = FakeStripeHandler.RejectingInFlightRepeats();
        var releaseWinner = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var arrivals = 0;
        stripe.OnRequest = async _ =>
        {
            if (Interlocked.Increment(ref arrivals) == 1)
            {
                await releaseWinner.Task.WaitAsync(TimeSpan.FromSeconds(15));
            }
        };
        var log = new SpanScopedLogger<CreateOrderService>();
        var client = ClientFor(stripeEnabled: true, stripe, serviceLog: log);

        var winner = client.PostAsJsonAsync("/v1/orders", OneLine());
        HttpResponseMessage duplicate;
        try
        {
            await UntilAsync(() => stripe.Charges.Count() == 1);
            duplicate = await client.PostAsJsonAsync("/v1/orders", OneLine());
        }
        finally
        {
            releaseWinner.TrySetResult();
        }

        Assert.Equal(HttpStatusCode.ServiceUnavailable, duplicate.StatusCode);
        Assert.Equal("payment_unavailable", (await duplicate.Content.ReadFromJsonAsync<ErrorBody>())!.Error);
        Assert.Equal(TimeSpan.FromSeconds(1), duplicate.Headers.RetryAfter?.Delta);
        Assert.Equal(HttpStatusCode.Created, (await winner).StatusCode);
        Assert.Equal(1, stripe.ChargesExecuted);
        var entries = log.Entries.ToArray();
        Assert.DoesNotContain(entries, e => e.Level >= LogLevel.Error);
        var line = Assert.Single(entries, e => Equals(e.Values.GetValueOrDefault("reason"), "idempotency_key_in_flight"));
        Assert.Equal(LogLevel.Warning, line.Level);
        Assert.Equal("create_order_failed", line.Values["app_event"]);
    }

    private async Task<string> AddProductAsync()
    {
        await using var db = _factory.NewWriteContext();
        var id = NanoId.NewId(NanoId.ProductPrefix);
        db.Products.Add(new Product
        {
            Id = id,
            Name = "Stripe Gadget",
            Description = "d",
            UnitPriceCents = 1200,
            UnitsInStock = 1000,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();
        return id;
    }

    private static async Task UntilAsync(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "Timed out waiting for the first charge to reach Stripe.");
            await Task.Delay(10);
        }
    }

    private object OneLine(int quantity = 1) => new
    {
        lines = new[] { new { productId = _productId, quantity } },
        paymentMethodId = PaymentMethodId,
    };

    private sealed record ErrorBody(string Error, string? Detail);
}
