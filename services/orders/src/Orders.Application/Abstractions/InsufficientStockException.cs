namespace Orders.Application.Abstractions;

public class InsufficientStockException : Exception
{
    public InsufficientStockException(string productId)
        : base($"insufficient stock for product {productId}") { }
}
