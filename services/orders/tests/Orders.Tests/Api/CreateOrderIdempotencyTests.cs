using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Orders.Application.Orders;
using Orders.Tests.Payments;

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

    private object OneLine(int quantity = 1) => new
    {
        lines = new[] { new { productId = _productId, quantity } },
        paymentMethodId = PaymentMethodId,
    };

    private sealed record ErrorBody(string Error, string? Detail);
}
