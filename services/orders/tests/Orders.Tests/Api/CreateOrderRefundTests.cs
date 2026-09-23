using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Orders.Tests.Payments;

namespace Orders.Tests.Api;

/// <summary>
/// The refund after a failure between a succeeded charge and the order's commit.
/// CONTRACT: Each failure is produced by changing the product from ANOTHER connection while the
/// charge is in flight — the real race, with no test seam in production code.
/// See [[2026-09-19-stripe-payments-design]]
/// </summary>
public partial class CreateOrderStripeTests
{
    [Fact]
    public async Task CreateOrder_WhenReservationConflictsAfterSuccessfulCharge_RefundsTheCharge()
    {
        var stripe = FakeStripeHandler.Succeeding();
        stripe.OnRequest = _ => ChangeProductMidChargeAsync("UPDATE product SET units_in_stock = 0 WHERE id = {0}");
        var client = ClientFor(stripeEnabled: true, stripe);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
            paymentMethodId = PaymentMethodId,
        });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var orderId = AssertRefundedTheCharge(stripe);
        Assert.Null(await LoadOrderAsync(orderId));
    }

    [Fact]
    public async Task CreateOrder_WhenTheProductIsDeletedAfterSuccessfulCharge_RefundsTheCharge()
    {
        var stripe = FakeStripeHandler.Succeeding();
        stripe.OnRequest = _ => ChangeProductMidChargeAsync("UPDATE product SET deleted_at = UTC_TIMESTAMP() WHERE id = {0}");
        var client = ClientFor(stripeEnabled: true, stripe);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
            paymentMethodId = PaymentMethodId,
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var orderId = AssertRefundedTheCharge(stripe);
        Assert.Null(await LoadOrderAsync(orderId));
    }

    [Fact]
    public async Task CreateOrder_WhenThePriceChangesAfterSuccessfulCharge_RefundsTheCharge()
    {
        var stripe = FakeStripeHandler.Succeeding();
        stripe.OnRequest = _ => ChangeProductMidChargeAsync(
            "UPDATE product SET unit_price_cents = unit_price_cents + 100 WHERE id = {0}");
        var client = ClientFor(stripeEnabled: true, stripe);

        // WHY: The mismatch guard throws an unhandled InvalidOperationException; depending on the
        // host's exception middleware it surfaces as a 500 or as the exception itself.
        try
        {
            var response = await client.PostAsJsonAsync("/v1/orders", new
            {
                lines = new[] { new { productId = _productId, quantity = 1 } },
                paymentMethodId = PaymentMethodId,
            });
            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        }
        catch (InvalidOperationException)
        {
        }

        var orderId = AssertRefundedTheCharge(stripe);
        Assert.Null(await LoadOrderAsync(orderId));
    }

    [Fact]
    public async Task CreateOrder_WhenTheSaveFailsAfterSuccessfulCharge_RefundsTheCharge()
    {
        var stripe = FakeStripeHandler.Succeeding();
        // WHY: The order id is derived from (user, key), so a row with that id inserted by
        // ANOTHER connection mid-charge makes this request's own save fail on the primary key.
        stripe.OnRequest = r => InsertConflictingOrderAsync(r.Form["metadata[order_id]"].ToString());
        var client = ClientFor(stripeEnabled: true, stripe);

        try
        {
            var response = await client.PostAsJsonAsync("/v1/orders", new
            {
                lines = new[] { new { productId = _productId, quantity = 1 } },
                paymentMethodId = PaymentMethodId,
            });
            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        }
        catch (Microsoft.EntityFrameworkCore.DbUpdateException)
        {
        }

        AssertRefundedTheCharge(stripe);
    }

    [Fact]
    public async Task CreateOrder_WhenTheRefundItselfFails_StillAnswersWithTheOriginalConflict()
    {
        var stripe = FakeStripeHandler.SucceedingWithFailingRefund();
        stripe.OnRequest = _ => ChangeProductMidChargeAsync("UPDATE product SET units_in_stock = 0 WHERE id = {0}");
        var client = ClientFor(stripeEnabled: true, stripe);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
            paymentMethodId = PaymentMethodId,
        });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.DoesNotContain("rk_", await response.Content.ReadAsStringAsync());
        Assert.Single(stripe.Refunds);
    }

    [Fact]
    public async Task CreateOrder_WhenTheOrderCommits_IssuesNoRefund()
    {
        var stripe = FakeStripeHandler.Succeeding();
        var client = ClientFor(stripeEnabled: true, stripe);

        var response = await client.PostAsJsonAsync("/v1/orders", new
        {
            lines = new[] { new { productId = _productId, quantity = 1 } },
            paymentMethodId = PaymentMethodId,
        });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Empty(stripe.Refunds);
    }

    /// <summary>
    /// Asserts exactly one refund, for the exact PaymentIntent the charge returned, with an
    /// idempotency key derived from it. Returns the order id the charge was taken for.
    /// </summary>
    private static string AssertRefundedTheCharge(FakeStripeHandler stripe)
    {
        var charge = Assert.Single(stripe.Charges);
        var refund = Assert.Single(stripe.Refunds);
        Assert.Equal(FakeStripeHandler.PaymentIntentId, refund.Form["payment_intent"]);
        Assert.Equal($"refund-{FakeStripeHandler.PaymentIntentId}", refund.IdempotencyKey);
        Assert.False(refund.Form.ContainsKey("amount"));
        var orderId = charge.Form["metadata[order_id]"].ToString();
        Assert.Equal(orderId, refund.Form["metadata[order_id]"]);
        return orderId;
    }

    private async Task InsertConflictingOrderAsync(string orderId)
    {
        // CONTRACT: An identity no other test uses — the database is shared by the whole
        // collection, and CacheCrossUserTests asserts the factory's OTHER user has no orders.
        await using var db = _factory.NewWriteContext();
        db.Orders.Add(new Orders.Domain.Entities.Order
        {
            Id = orderId,
            UserId = "usr_conflictingrow",
            CognitoSub = "sub-conflicting-row",
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        });
        await db.SaveChangesAsync();
    }

    private async Task ChangeProductMidChargeAsync(string sql)
    {
        await using var db = _factory.NewWriteContext();
        await db.Database.ExecuteSqlRawAsync(sql, _productId);
    }
}
