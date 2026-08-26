namespace Orders.Domain.Entities;

/// <summary>
/// A user's in-progress selection of products. At most ONE active cart per user.
/// </summary>
/// <remarks>
/// <para>
/// The one-active-cart invariant is enforced by a UNIQUE INDEX in the database
/// (see CartConfiguration), not by a check in service code — two concurrent
/// requests would both pass a "does one already exist?" read and both insert.
/// </para>
/// <para>
/// A cart with no live lines DOES NOT EXIST: emptying a cart deletes it. See
/// CartWriteService, which routes every deletion path through one method.
/// </para>
/// </remarks>
public class Cart : AuditableEntity
{
    public string UserId { get; set; } = string.Empty;      // internal usr_ id
    public string CognitoSub { get; set; } = string.Empty;  // from the gateway

    public List<CartItem> Items { get; set; } = new();
}
