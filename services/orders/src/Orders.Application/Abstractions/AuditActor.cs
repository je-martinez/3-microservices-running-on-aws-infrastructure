namespace Orders.Application.Abstractions;

// Semantic actor stamped into CreatedBy/UpdatedBy/DeletedBy by the audit interceptor.
// CONTRACT: Format is `<source>:<action>`, never a bare id — the audit columns must be
// self-describing and greppable (`orders_api:create_order`). Every write path here comes from
// the Orders API, so the source is uniformly `orders_api`. Add members when new callers
// appear, never speculatively. A static class of consts because a C# enum cannot hold
// arbitrary strings. See [[audit-fields]]
public static class AuditActor
{
    public const string CreateOrder = "orders_api:create_order";
    public const string UpdateCart = "orders_api:update_cart";
    public const string DeleteCart = "orders_api:delete_cart";
    public const string ProductSeed = "orders_api:product_seed";
    public const string ConfigSeed = "orders_api:config_seed";
    public const string E2eCleanup = "orders_api:e2e_cleanup";

    // DELETE /v1/orders/by-user — the account-deletion cascade from Users. Its own
    // actor rather than the end user's identity: a row removed because the account
    // was deleted must stay distinguishable from one the user removed themselves,
    // which is exactly what deleted_by exists to record.
    public const string DeleteByUser = "orders_api:delete_by_user";
}
