using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Orders.Application.Abstractions;
using Orders.Domain.Entities;

namespace Orders.Infrastructure.Persistence;

// SaveChanges interceptor that stamps the audit columns on every tracked
// AuditableEntity — the .NET analog of the Users service's Prisma audit query
// extension. The acting identity comes from AmbientActor.Current, which write
// paths set by wrapping their persistence in `AmbientActor.RunAsync(AuditActor.X,
// ...)`; the actor records WHAT produced the row (`orders_api:create_order`)
// rather than a bare id.
//
// Null-actor policy (no RunAsync scope active): leave whatever the code set
// explicitly and never throw. Timestamps are still centralized here (Added stamps
// CreatedAt/UpdatedAt if unset; Modified always bumps UpdatedAt) so behavior is
// consistent, but the *_By columns are only overwritten when an ambient actor is
// present — this keeps direct/tests-only writes working and never crashes a save.
//
// ExecuteUpdate/ExecuteDelete bypass SaveChanges entirely, so they do NOT flow
// through this interceptor; the E2E cleanup endpoint stamps DeletedBy explicitly
// (see E2eEndpoints).
//
// Tracked `.Remove()`/`RemoveRange()` deletes (including cascade deletes) ARE
// caught here and REWRITTEN to soft-deletes: an AuditableEntity in the Deleted
// state is flipped to Modified and its DeletedAt/DeletedBy stamped, so EF issues
// an UPDATE instead of a physical DELETE. This makes ADR-0004 (soft-delete only)
// hold at the code layer, not merely by convention. The set-based ExecuteDelete
// path still bypasses this interceptor and must never be used.
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
