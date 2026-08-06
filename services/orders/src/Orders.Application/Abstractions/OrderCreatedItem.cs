namespace Orders.Application.Abstractions;

/// <summary>
/// One line of the receipt the ORDER_CREATED email renders: what was bought, how many, and
/// at what unit price.
/// </summary>
/// <remarks>
/// <para>
/// It carries <see cref="Name"/> rather than a product id because <c>OrderDetail</c> — the
/// row that records the line — stores only <c>ProductId</c>. A receipt listing
/// <c>prd_8Kd2…</c> is not a receipt, so the name has to travel WITH the event: the
/// consumer has no access to the Orders database and cannot resolve an id into a label.
/// </para>
/// <para>
/// Assembled in <c>CreateOrderService</c>'s pricing loop, where each <c>Product</c> entity
/// is already loaded and locked in order to read its price and decrement its stock. Building
/// it there is what keeps this an IN-MEMORY projection: neither a second query nor a
/// denormalized name column on <c>OrderDetail</c> is needed to produce it.
/// </para>
/// <para>
/// A point-in-time snapshot, like the order's own money columns: the name and unit price are
/// the ones in force when the order was placed, so a later catalogue rename or repricing
/// never rewrites what a past receipt said.
/// </para>
/// </remarks>
/// <param name="Name">The product's name as it stood when the order was placed.</param>
/// <param name="Quantity">Units bought of this product, after duplicate lines are consolidated.</param>
/// <param name="UnitPriceCents">
/// The per-unit price in cents, matching the money convention (integer cents, never decimal).
/// The line's own total is deliberately NOT sent: the template multiplies, and shipping a
/// second figure that could disagree with quantity × unit price would make the receipt
/// capable of contradicting itself.
/// </param>
public sealed record OrderCreatedItem(string Name, uint Quantity, long UnitPriceCents);
