using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Orders.Infrastructure.Persistence;

// Applies a pessimistic row lock (FOR UPDATE) to a query tagged with `Tag`, so the
// service can lock in pure LINQ instead of raw SQL — which lets EF Core's global
// soft-delete query filter (deleted_at IS NULL) apply automatically (ADR-0004).
//
// The service writes: _db.Products.TagWith(ForUpdateInterceptor.Tag).First...(...).
// EF emits that tag as a leading `-- orders:for-update` SQL comment; this
// interceptor detects it and appends ` FOR UPDATE`.
//
// MySQL-SPECIFIC: `FOR UPDATE` is InnoDB/Postgres syntax (Aurora MySQL here).
// If the engine ever changes, this is the single place to adjust.
public sealed class ForUpdateInterceptor : DbCommandInterceptor
{
    public const string Tag = "orders:for-update";

    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result)
    {
        command.CommandText = ApplyForUpdate(command.CommandText);
        return base.ReaderExecuting(command, eventData, result);
    }

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        command.CommandText = ApplyForUpdate(command.CommandText);
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }

    // Pure, unit-testable rewrite. Appends FOR UPDATE only when: the SQL carries
    // our tag comment, is a SELECT, and doesn't already lock. Everything else is
    // returned unchanged.
    internal static string ApplyForUpdate(string sql)
    {
        if (!sql.Contains(Tag, StringComparison.Ordinal))
            return sql;
        if (sql.Contains("FOR UPDATE", StringComparison.OrdinalIgnoreCase))
            return sql;

        // Must be a SELECT (never mutate INSERT/UPDATE/DELETE). Check the first
        // non-comment statement keyword.
        var firstKeyword = FirstSqlKeyword(sql);
        if (!string.Equals(firstKeyword, "SELECT", StringComparison.OrdinalIgnoreCase))
            return sql;

        return sql.TrimEnd().TrimEnd(';') + " FOR UPDATE";
    }

    private static string FirstSqlKeyword(string sql)
    {
        foreach (var raw in sql.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("--", StringComparison.Ordinal))
                continue;
            var space = line.IndexOf(' ');
            return space < 0 ? line : line[..space];
        }
        return string.Empty;
    }
}
