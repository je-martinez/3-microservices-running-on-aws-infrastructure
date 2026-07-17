namespace Orders.Domain.Entities;

// Generic key/value configuration row. The Key IS the primary key (not a nano-id).
// Value is a plain string; callers parse it (e.g. tax_rate is a decimal string
// like "0.08"). Inherits the standard audit fields + soft-delete (Id is unused
// here — Key is the identity — but AuditableEntity supplies the audit columns).
public class Configuration : AuditableEntity
{
    public string Key { get; set; } = string.Empty;
    public string Value { get; set; } = string.Empty;
}
