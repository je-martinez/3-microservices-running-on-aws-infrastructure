namespace Orders.Application.Carts;

/// <param name="Quantity">
/// Zero means REMOVE this line — it is a valid instruction, not an error. Negative values
/// are rejected at the API boundary before a command is ever built.
/// </param>
public record CartLineInput(string ProductId, uint Quantity);

/// <summary>
/// A full REPLACEMENT of the cart's line set: whatever is not in <paramref name="Items"/>
/// is removed. An empty list therefore deletes the cart.
/// </summary>
public record UpdateCartCommand(IReadOnlyList<CartLineInput> Items);
