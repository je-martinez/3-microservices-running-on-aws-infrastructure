namespace Orders.Domain.Entities;

/// <summary>
/// A user's in-progress selection of products. At most ONE active cart per user.
/// </summary>
/// <remarks>
/// CONTRACT: The one-active-cart invariant is enforced by a UNIQUE INDEX, never by a check in
/// service code — two concurrent requests both pass a "does one exist?" read and both insert.
/// A cart with no live lines does not exist: emptying one deletes it.
/// See [[orders-service-design]]
/// </remarks>
public class Cart : AuditableEntity
{
    public string UserId { get; set; } = string.Empty;      // internal usr_ id
    public string CognitoSub { get; set; } = string.Empty;  // from the gateway

    public List<CartItem> Items { get; set; } = new();
}
