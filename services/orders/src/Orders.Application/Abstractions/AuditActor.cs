namespace Orders.Application.Abstractions;

// Semantic actor stamped into CreatedBy/UpdatedBy (and DeletedBy) by the audit
// SaveChanges interceptor (see Orders.Infrastructure.Persistence.AuditInterceptor
// and AmbientActor). Value format: `<source>:<action>`.
//
// All current write paths originate from the Orders API itself (its endpoints and
// local seed/bootstrap — not an admin console), so the source is uniformly
// `orders_api`; the action distinguishes what produced the row. This replaces the
// previous practice of stamping a bare id/string, so the audit columns are
// self-describing and greppable (e.g. `orders_api:create_order`) instead of
// opaque. Add members (and, if ever needed, new sources) when new callers appear
// — never widen it speculatively (YAGNI).
//
// A C# enum cannot hold arbitrary string values, so this is a static class of
// const strings (the .NET analog of the Users service's `AuditActor` enum).
public static class AuditActor
{
    public const string CreateOrder = "orders_api:create_order";
    public const string ProductSeed = "orders_api:product_seed";
    public const string ConfigSeed = "orders_api:config_seed";
    public const string E2eCleanup = "orders_api:e2e_cleanup";
}
