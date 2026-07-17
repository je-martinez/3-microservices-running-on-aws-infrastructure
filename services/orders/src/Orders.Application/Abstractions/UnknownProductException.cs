namespace Orders.Application.Abstractions;

public class UnknownProductException : Exception
{
    public UnknownProductException(string productId)
        : base($"unknown product {productId}") { }
}
