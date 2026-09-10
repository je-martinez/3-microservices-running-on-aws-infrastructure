namespace Orders.Application.Identity;

/// <summary>
/// The caller as Users knows them, from one <c>GetUserById</c> round trip: the internal
/// <c>usr_</c> id order creation stamps, the email and name ORDER_CREATED needs, and the
/// address it snapshots (<c>null</c> when none is on file).
/// CONTRACT: <c>FullName</c> is non-nullable, defaulting to <c>""</c> — proto3 has no null,
/// so a nameless user arrives empty rather than absent. Nulling it has the consumer reject
/// the envelope and costs the buyer their confirmation email.
/// WARNING: PII. Never log the email, name or address — log <c>EmailHash.Compute</c>.
/// See [[logging-context]]
/// </summary>
public sealed record CallerProfile(
    string InternalUserId,
    string Email,
    string FullName,
    CallerAddress? Address);

/// <summary>
/// A delivery address as it crosses the Users boundary, with the wire encoding already
/// normalized away.
/// </summary>
/// <remarks>
/// CONTRACT: Every field is nullable and "not provided" is always <c>null</c>. proto3 scalars
/// have no null, so an absent key arrives as <c>""</c>; the adapter normalizes that once so
/// nothing downstream repeats the "empty means absent" rule. Field names mirror
/// <c>users.v1.Address</c> one for one — a frozen value object, not an evolving contract.
/// WARNING: PII. Never log this, not even one field. See [[logging-context]]
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
    /// True when every field is absent. proto3 always materializes an <c>Address</c>
    /// message, so a user with none on file arrives as all-empty strings; callers collapse
    /// that back to <c>null</c> rather than storing an object that reads as an address.
    /// </summary>
    public bool IsEmpty =>
        Line1 is null && Line2 is null && City is null
        && State is null && Country is null && PostalCode is null;
}
