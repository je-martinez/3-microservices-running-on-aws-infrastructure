namespace Orders.Application.Identity;

/// <summary>
/// The caller as Users knows them, resolved in a single <c>GetUserById</c> round trip:
/// the internal id order creation must stamp, the email the ORDER_CREATED consumer needs,
/// plus the delivery address it snapshots.
/// </summary>
/// <param name="InternalUserId">The internal <c>usr_</c> id.</param>
/// <param name="Email">
/// The caller's email address. Carried because the events-pipeline's ORDER_CREATED handler
/// requires it in the payload (it is who the confirmation email is sent to), and it already
/// rides on the SAME <c>GetUserById</c> response that resolves the id — see
/// <c>users.v1.UserResponse.email</c>. No extra round trip, no new dependency.
/// PII — never log it in plaintext; log <c>EmailHash.Compute</c> instead (see the
/// logging-context convention).
/// </param>
/// <param name="Address">
/// The caller's delivery address, or <c>null</c> when they have none on file. PII —
/// never log it (see the logging-context convention).
/// </param>
public sealed record CallerProfile(string InternalUserId, string Email, CallerAddress? Address);

/// <summary>
/// A delivery address as it crosses the Users boundary, with the wire encoding already
/// normalized away.
/// </summary>
/// <remarks>
/// <para>
/// <b>Every field is nullable, and "not provided" is always <c>null</c>.</b> proto3 scalars
/// have no null: a key absent from the JSON Users stores (commonly <c>line2</c>,
/// <c>state</c>, <c>postal_code</c>) arrives as <c>""</c>, not null. That is a fact about
/// the transport, so the adapter that speaks the transport normalizes it, and nothing
/// downstream — the snapshot on the order, the body sent to Tracking, a future consumer —
/// has to know that gRPC was ever involved or repeat the "empty means absent" rule.
/// </para>
/// <para>
/// This record lives in Application rather than Infrastructure so the port can express the
/// address without dragging the generated gRPC types across the dependency boundary.
/// </para>
/// <para>
/// Field names mirror <c>users.v1.Address</c> (and <c>tracking.v1.Address</c>) one for one;
/// they are a frozen value object, not an evolving contract.
/// </para>
/// <para>
/// PII — never log this, not even one field. See the logging-context convention.
/// </para>
/// </remarks>
public sealed record CallerAddress(
    string? Line1,
    string? Line2,
    string? City,
    string? State,
    string? Country,
    string? PostalCode)
{
    /// <summary>
    /// True when the address carries no information at all — every field absent.
    /// </summary>
    /// <remarks>
    /// proto3 always materializes a present <c>Address</c> message, and Users returns one
    /// whose fields are all <c>""</c> for a user with no address on file. Persisting that
    /// would store an object of empty strings that reads as "we have an address" while
    /// meaning the opposite. Callers use this to collapse it back to <c>null</c>.
    /// </remarks>
    public bool IsEmpty =>
        Line1 is null && Line2 is null && City is null
        && State is null && Country is null && PostalCode is null;
}
