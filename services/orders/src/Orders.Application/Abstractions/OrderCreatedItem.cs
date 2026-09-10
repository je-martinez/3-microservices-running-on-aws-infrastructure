namespace Orders.Application.Abstractions;

/// <summary>
/// One line of the receipt the ORDER_CREATED email renders.
/// CONTRACT: Carries the product NAME, not its id — the consumer cannot resolve one, and
/// name and price are a point-in-time snapshot so a later repricing cannot rewrite a past
/// receipt. Do NOT add the line's own total: the template multiplies, and a second figure on
/// the wire lets the receipt contradict itself. See [[money-representation]]
/// </summary>
public sealed record OrderCreatedItem(string Name, uint Quantity, long UnitPriceCents);
