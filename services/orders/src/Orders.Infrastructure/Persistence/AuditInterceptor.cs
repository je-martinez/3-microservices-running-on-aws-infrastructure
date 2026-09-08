using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Orders.Application.Abstractions;
using Orders.Domain.Entities;

namespace Orders.Infrastructure.Persistence;

// Stamps the audit columns on every tracked AuditableEntity, reading the actor from
// AmbientActor.Current.
// CONTRACT: Tracked deletes are REWRITTEN to soft-deletes here — a Deleted entity is flipped
// to Modified with DeletedAt/DeletedBy stamped, so EF issues an UPDATE. This is what makes
// soft-delete hold in code rather than by convention; ExecuteDelete bypasses it entirely and
// must never be used. See [[ADR-0004-soft-delete-only]]
// CONTRACT: With no actor scope active, leave what the code set and never throw — timestamps
// are still stamped, so direct and test writes keep working. See [[audit-fields]]
public sealed class AuditInterceptor : SaveChangesInterceptor
{
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        if (eventData.Context is not null)
        {
            Stamp(eventData.Context);
        }

        return base.SavingChangesAsync(eventData, result, cancellationToken);
    }

    private static void Stamp(DbContext context)
    {
        var actor = AmbientActor.Current;
        var now = DateTime.UtcNow;

        foreach (var entry in context.ChangeTracker.Entries<AuditableEntity>())
        {
            switch (entry.State)
            {
                case EntityState.Added:
                    if (entry.Entity.CreatedAt == default) entry.Entity.CreatedAt = now;
                    if (entry.Entity.UpdatedAt == default) entry.Entity.UpdatedAt = now;
                    if (actor is not null)
                    {
                        entry.Entity.CreatedBy = actor;
                        entry.Entity.UpdatedBy = actor;
                    }
                    break;

                case EntityState.Modified:
                    entry.Entity.UpdatedAt = now;
                    if (actor is not null)
                    {
                        entry.Entity.UpdatedBy = actor;
                    }

                    // Soft-delete just performed via the change tracker (DeletedAt
                    // set on a loaded entity, then SaveChanges) — stamp DeletedBy.
                    if (IsJustSoftDeleted(entry) && actor is not null)
                    {
                        entry.Entity.DeletedBy = actor;
                    }
                    break;

                case EntityState.Deleted:
                    // A tracked .Remove()/RemoveRange() (or cascade delete) would
                    // emit a physical DELETE. Flip to Modified so EF issues an
                    // UPDATE instead — this is the documented way to cancel a
                    // delete — then stamp the soft-delete columns. ADR-0004 is thus
                    // enforced in code, not just by never calling Remove().
                    entry.State = EntityState.Modified;
                    if (entry.Entity.DeletedAt is null) entry.Entity.DeletedAt = now;
                    entry.Entity.UpdatedAt = now;
                    if (actor is not null)
                    {
                        entry.Entity.DeletedBy = actor;
                        entry.Entity.UpdatedBy = actor;
                    }
                    break;
            }
        }
    }

    // True when DeletedAt was changed from null to a value in this SaveChanges.
    private static bool IsJustSoftDeleted(EntityEntry<AuditableEntity> entry)
    {
        var deletedAt = entry.Property(e => e.DeletedAt);
        return entry.Entity.DeletedAt is not null
            && deletedAt.IsModified
            && deletedAt.OriginalValue is null;
    }
}
