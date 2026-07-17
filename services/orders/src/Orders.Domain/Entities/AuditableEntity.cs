namespace Orders.Domain.Entities;

// Standard audit fields + soft-delete for every entity. See soft-delete / audit-fields conventions.
public abstract class AuditableEntity
{
    public string Id { get; set; } = string.Empty;
    public string? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; }
    public string? UpdatedBy { get; set; }
    public DateTime UpdatedAt { get; set; }
    public string? DeletedBy { get; set; }
    public DateTime? DeletedAt { get; set; }

    // Computed, not persisted.
    public bool IsDeleted => DeletedAt is not null;
}
