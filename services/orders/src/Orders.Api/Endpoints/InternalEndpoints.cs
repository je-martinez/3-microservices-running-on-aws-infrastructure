using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Orders.Api.Identity;
using Orders.Application.Abstractions;
using Orders.Infrastructure.Caching;
using Orders.Infrastructure.Carts;
using Orders.Infrastructure.Observability;
using Orders.Infrastructure.Persistence;

namespace Orders.Api.Endpoints;

/// <summary>
/// Service-to-service routes. Not published on the API Gateway; authenticated with
/// the shared internal key, never a user JWT.
/// </summary>
public static class InternalEndpoints
{
    /// <summary>
    /// Binary collation pinned on the cascade's ownership predicates. Taken from
    /// <see cref="CartWriteService"/> rather than spelled out again here, so the API and
    /// Infrastructure halves of the same cascade cannot drift onto different collations.
    /// </summary>
    private const string BinaryCollation = CartWriteService.BinaryCollation;

    public static void MapInternalEndpoints(this WebApplication app)
    {
        app.MapDelete("/v1/orders/by-user", async (
            // [FromBody] is REQUIRED, not decorative. Minimal APIs refuse to INFER a
            // body parameter on DELETE (as on GET/HEAD), which the spec treats as
            // body-less: without the attribute the route throws
            // "Body was inferred but the method does not allow inferred body
            // parameters" while the endpoint is being built — which is at build time
            // here, since the OpenAPI generator walks every endpoint, so the whole
            // `dotnet build` fails rather than just this route.
            //
            // The subject stays in the body regardless: it is an identity, and an
            // identity does not belong in a URL that lands in access logs.
            [FromBody] InternalDeleteByUserRequest body,
            HttpRequest http,
            IConfiguration config,
            OrdersWriteDbContext db,
            IWorkflowTracer tracer,
            // The INTERFACE, never ICacheGateway: with CACHE_ENABLED=false no gateway is
            // registered at all, and resolving one directly would make the kill switch
            // take this route down. NoopCacheInvalidator satisfies this in that branch.
            ICacheInvalidator cache,
            // Injected rather than loggerFactory.CreateLogger("…literal…"): every other
            // logging site in Orders takes ILogger<T>, and a hand-typed category string
            // silently diverges from reality the moment this file is renamed or moved,
            // with nothing to fail on it.
            ILogger<InternalEndpointsCategory> logger,
            CancellationToken ct) =>
        {
            var provided = http.Headers[InternalApiKey.HeaderName].FirstOrDefault();

            if (!InternalApiKey.Matches(provided, config["GRPC_API_KEY"]!))
            {
                // A mass soft-delete surface is the widest blast radius in this
                // service; failed attempts are worth seeing. NEVER log the key — not
                // a prefix, not its length. The remote address IS logged, mirroring
                // Tracking's equivalent guard: on the widest attack surface here, the
                // only actionable fact about a rejected attempt is where it came from.
                //
                // Deliberately OUTSIDE the workflow span: an unauthenticated request
                // never started the flow, so there is no flow to trace. The span and
                // the _started line both begin below, once the key has passed.
                logger.LogWarning(
                    "Rejected internal delete {app_event} {reason} {client}",
                    "internal_delete_by_user_failed",
                    "invalid_api_key",
                    http.HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown");
                return Results.Unauthorized();
            }

            return await tracer.TraceWorkflowAsync(
                "internal_delete_by_user",
                new Dictionary<string, object?>
                {
                    ["app_event"] = "internal_delete_by_user_started",
                },
                async () =>
                {
                    // Emitted INSIDE the activity so it carries that span's span_id.
                    // A write with real intermediate steps gets the full triad, not the
                    // single line a read gets: the cascade spans four statements across
                    // three tables, and _started is genuinely the last line seen if any
                    // of them faults.
                    logger.LogInformation(
                        "Starting internal delete by user {app_event}",
                        "internal_delete_by_user_started");

                    // BOTH identities are required, and this is load-bearing rather than
                    // defensive. The predicates below are an OR, and `cognito_sub` and
                    // `user_id` are both NOT NULL varchar in MySQL — which still permits
                    // the EMPTY STRING. An empty value reaching either side of that OR
                    // would match every row whose column was left blank or never
                    // backfilled, i.e. it would erase someone else's data. Rejecting here
                    // is the only thing standing between a malformed call and that.
                    if (string.IsNullOrWhiteSpace(body.CognitoSub))
                    {
                        logger.LogWarning(
                            "Internal delete rejected {app_event} {reason}",
                            "internal_delete_by_user_failed", "cognito_sub_required");
                        tracer.SetReason("cognito_sub_required");
                        return Results.BadRequest(new { error = "cognito_sub_required" });
                    }

                    // A distinct reason, not a shared "identity_required": the caller is
                    // Users, and which of the two fields it failed to send is the only
                    // fact that tells an operator where the bug is.
                    if (string.IsNullOrWhiteSpace(body.UserId))
                    {
                        logger.LogWarning(
                            "Internal delete rejected {app_event} {reason}",
                            "internal_delete_by_user_failed", "user_id_required");
                        tracer.SetReason("user_id_required");
                        return Results.BadRequest(new { error = "user_id_required" });
                    }

                    var now = DateTime.UtcNow;

                    int deletedDetails;
                    int deleted;
                    var deletedCarts = 0;

                    try
                    {
                        // Details FIRST, then orders — the same ordering the E2E cleanup
                        // uses and for the same reason: the detail predicate is a subquery
                        // over the parent orders, and orders soft-deleted first would be
                        // hidden from it by their own global query filter, orphaning every
                        // line as a live child of a deleted parent.
                        //
                        // Selected through order_id rather than by the ownership columns
                        // directly: order_details carries them denormalized but has NO index
                        // on either (only order_id, product_id, deleted_at), so keying on
                        // them would table-scan.
                        //
                        // The inner selection mirrors the orders predicate below EXACTLY,
                        // OR included — the binary collation too. If it did not, the cascade
                        // would soft-delete a parent order while leaving its lines live —
                        // orphaned children of a deleted parent, the precise bug the ordering
                        // below exists to avoid.
                        //
                        // COLLATE utf8mb4_bin: see the note on the orders sweep below. It has
                        // to be here as well, or the two predicates select different row sets
                        // and the cascade goes right back to being inconsistent.
                        deletedDetails = await db.OrderDetails
                            .Where(d => db.Orders
                                .Where(o => EF.Functions.Collate(o.CognitoSub, BinaryCollation)
                                        == EF.Functions.Collate(body.CognitoSub, BinaryCollation)
                                    || EF.Functions.Collate(o.UserId, BinaryCollation)
                                        == EF.Functions.Collate(body.UserId, BinaryCollation))
                                .Select(o => o.Id)
                                .Contains(d.OrderId) && d.DeletedAt == null)
                            .ExecuteUpdateAsync(s => s
                                .SetProperty(d => d.DeletedAt, now)
                                .SetProperty(d => d.DeletedBy, AuditActor.DeleteByUser), ct);

                        // `DeletedAt == null` guards keep this idempotent: a retry after a
                        // partial cascade failure re-runs harmlessly and reports 0.
                        //
                        // ExecuteUpdate issues one SQL UPDATE and BYPASSES SaveChanges, so
                        // the AuditInterceptor never runs — DeletedBy is stamped explicitly
                        // here.
                        //
                        // EITHER identity matches, mirroring Tracking's sibling route.
                        // `cognito_sub` is NOT the durable identity: a user who deletes
                        // their account and signs up again gets a NEW sub from Cognito,
                        // while the internal `usr_` id never changes. Matching on both means
                        // a row whose sub was left empty or fell out of sync is still
                        // reachable by an erasure request, and it is free — Orders indexes
                        // both columns (idx_order_user_id, idx_order_cognito_sub).
                        //
                        // COLLATE utf8mb4_bin IS A SAFETY CONTROL, NOT A TUNING KNOB — and
                        // this is the canonical note the other two sites in this cascade
                        // point back to.
                        //
                        // `order.user_id` and `order.cognito_sub` are utf8mb4_0900_ai_ci —
                        // case-INSENSITIVE — while the ids they hold come from a MIXED-CASE
                        // alphabet (`A-Za-z0-9`, see NanoIdConfig.Alphabet and [[nano-id]])
                        // minted by Users' Postgres, which compares case-SENSITIVELY. So
                        // Postgres can legitimately issue `usr_AbC…` and `usr_abc…` as two
                        // DIFFERENT people that MySQL cannot tell apart, and an erasure keyed
                        // on one would sweep the other's orders, lines and cart — reporting a
                        // cheerful 200 with a non-zero count and logging *_succeeded while
                        // doing it. Verified against the live database on 2026-08-26:
                        // `SELECT 'usr_AbC' = 'usr_abc'` returns 1, and a real row matched its
                        // own id with the case inverted.
                        //
                        // Pinned at the PREDICATE rather than fixed in the schema because that
                        // keeps the change scoped to the IRREVERSIBLE operation. The
                        // user-scoped READS share the same root cause and are deliberately
                        // left alone: a read returning a neighbour's row is a bug, but a soft
                        // delete removing it has no undelete primitive anywhere in this
                        // service, so recovery means hand-written SQL. Mirrors Tracking's
                        // sibling route, which pins the same collation on the same predicate.
                        //
                        // BOTH SIDES are collated. Pinning only the column leaves MySQL to
                        // resolve the comparison's collation from the two operands, and a
                        // mismatch there is an error rather than the behaviour wanted.
                        deleted = await db.Orders
                            .Where(o => (EF.Functions.Collate(o.CognitoSub, BinaryCollation)
                                        == EF.Functions.Collate(body.CognitoSub, BinaryCollation)
                                    || EF.Functions.Collate(o.UserId, BinaryCollation)
                                        == EF.Functions.Collate(body.UserId, BinaryCollation))
                                && o.DeletedAt == null)
                            .ExecuteUpdateAsync(s => s
                                .SetProperty(o => o.DeletedAt, now)
                                .SetProperty(o => o.DeletedBy, AuditActor.DeleteByUser), ct);

                        // The cart goes through the shared primitive rather than a fourth
                        // bespoke UPDATE: it must remove the LINES too, or the cart_item
                        // unique index stays occupied. AmbientActor drives the interceptor,
                        // since this path DOES use SaveChanges.
                        //
                        // The three-argument overload, which ORs both identities like the
                        // statements above. It exists SEPARATELY from the two-argument one
                        // used by DELETE /v1/cart, an emptying PUT, and checkout: those act
                        // for a live request whose identity is the current sub, and widening
                        // them would let a checkout destroy a cart that merely shares a
                        // `usr_` id under an older sub. Erasure is the one caller that
                        // prefers deleting too much to leaving data behind.
                        await AmbientActor.RunAsync(AuditActor.DeleteByUser, async () =>
                        {
                            // Collated like the two statements above (see the canonical note
                            // on the orders sweep), and for a second reason of its own: this
                            // count is what the response and the _succeeded line report as
                            // deleted_carts. Left case-insensitive it would count a
                            // neighbour's cart that DeleteForUserAsync — correctly collated —
                            // does not delete, so the number reported would not describe what
                            // happened.
                            var before = await db.Carts
                                .CountAsync(c => EF.Functions.Collate(c.CognitoSub, BinaryCollation)
                                        == EF.Functions.Collate(body.CognitoSub, BinaryCollation)
                                    || EF.Functions.Collate(c.UserId, BinaryCollation)
                                        == EF.Functions.Collate(body.UserId, BinaryCollation), ct);
                            await CartWriteService.DeleteForUserAsync(
                                db, body.CognitoSub, body.UserId, ct);
                            await db.SaveChangesAsync(ct);
                            deletedCarts = before;
                        });
                    }
                    catch (Exception ex)
                    {
                        // A DB fault mid-cascade is a real failure branch, and without this
                        // it 500s carrying no app_event and no reason at all — the one
                        // outcome an operator most needs to find, invisible to every
                        // `app_event LIKE '%_failed'` query.
                        //
                        // Rethrown so the HTTP contract is unchanged (still a 500) and so
                        // TraceWorkflowAsync records the exception and ERROR status on the
                        // span; SetReason runs first so the reason is already on the span
                        // when it does.
                        logger.LogError(
                            ex,
                            "Internal delete failed {app_event} {reason}",
                            "internal_delete_by_user_failed", "db_error");
                        tracer.SetReason("db_error");
                        throw;
                    }

                    // AFTER the cascade has committed, and OUTSIDE the try above — which
                    // rethrows, so reaching this line already means every statement landed.
                    // Invalidating earlier would be wrong in the way the write services
                    // document: a concurrent read in the window before the commit would
                    // repopulate the entries with the pre-deletion state, and they would
                    // then sit there, stale, for their full TTL — up to an hour for the
                    // identity mapping.
                    //
                    // FAIL-OPEN, and here that matters more than anywhere else in the
                    // service. The rows are already gone; a Redis fault must not turn a
                    // cascade that HAPPENED into a 500 that tells Users it did not, because
                    // Users would then fail the whole account deletion for a person whose
                    // orders this service has genuinely erased. ICacheInvalidator swallows
                    // its own failures and logs a WARN with a machine-readable reason, so
                    // nothing propagates from here.
                    //
                    // BOTH identities are passed, and this route is the ONLY caller that
                    // holds both. Cache keys in this service are built from whatever the
                    // client put in x-user-id — CallerContextMiddleware stores that header
                    // verbatim as the sub without normalizing it, and Users' gRPC
                    // GetUserById resolves either a usr_ id or a Cognito sub, so clients
                    // legitimately send either. A user who authenticates with their usr_
                    // id owns orders:index:v1:usr_… and identity:sub-to-user:v1:usr_…,
                    // which a sweep of the sub alone never reaches.
                    //
                    // Passing only the sub here was a DATA LEAK, not an inefficiency: the
                    // cascade deleted a sub-keyed index that had never existed while the
                    // deleted user's real usr_-keyed entries survived, so GET
                    // /v1/orders/my-orders kept replaying an erased account's orders from
                    // cache (X-Cache: HIT) for up to 2 minutes, and their identity mapping
                    // kept resolving for up to an hour. The invalidator deduplicates, so
                    // the direct path — where both fields hold the same usr_ id — still
                    // issues one sweep.
                    await cache.InvalidateDeletedUserAsync(body.CognitoSub, body.UserId, ct);

                    // Carries BOTH subjects and all three counts. Without cognito_sub the
                    // line could not be joined to a user at all, and the detail/cart counts
                    // were computed and then thrown away — a partial cascade was only
                    // diagnosable from the HTTP response, which nobody keeps. user_id is
                    // logged alongside it now that the predicate is an OR: with only the sub
                    // on the line, a cascade that matched purely on user_id — the case this
                    // route was widened for — would report a count with no visible reason
                    // for it, since the sub it names matched nothing.
                    //
                    // Passing both by hand is NOT the "never re-pass identity at a call
                    // site" rule being broken: that rule assumes LogContextEnricher already
                    // supplies them, and it cannot here. The enricher reads ICurrentCaller,
                    // which is populated from an end-user request's x-user-id — and this
                    // route has no end user. Its caller is Users, holding only the API key,
                    // so both fields are empty on the enricher's side and the subject would
                    // otherwise appear on no line at all.
                    logger.LogInformation(
                        "Deleted orders for user {app_event} {cognito_sub} {user_id} " +
                        "{deleted_count} {deleted_details} {deleted_carts}",
                        "internal_delete_by_user_succeeded",
                        body.CognitoSub,
                        body.UserId,
                        deleted,
                        deletedDetails,
                        deletedCarts);

                    return Results.Ok(
                        new InternalDeleteResponse(deleted, deletedDetails, deletedCarts));
                });
        })
            .Accepts<InternalDeleteByUserRequest>("application/json")
            .WithTags("internal")
            .WithName("InternalDeleteByUser")
            .WithSummary("[Internal] Soft-delete every order, line and cart belonging to a user.")
            .Produces<InternalDeleteResponse>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status400BadRequest)
            .Produces(StatusCodes.Status401Unauthorized);
    }
}

/// <summary>
/// Logging category for the internal endpoints. A named type rather than a literal
/// string so the category is derived from the namespace the compiler knows about,
/// and follows the file if it ever moves — the failure mode a hand-typed
/// "Orders.Api.Endpoints.InternalEndpoints" has is that it keeps working while
/// pointing at a name that no longer exists.
/// </summary>
public sealed class InternalEndpointsCategory;

/// <summary>The subject to erase. Identity travels in the body, not a header, because
/// the caller is Users acting on the user's behalf — there is no end-user request here.</summary>
/// <remarks>
/// BOTH identities are carried, and the cascade matches on EITHER. They are not
/// interchangeable: <c>cognito_sub</c> is reissued when a user deletes their account and
/// registers again, so it is not durable, while the internal <c>usr_</c> id never changes.
/// Sending both lets erasure reach rows whose sub is stale, empty, or out of sync, and
/// mirrors Tracking's sibling route. Both fields are REQUIRED — see the handler for why an
/// empty one is dangerous rather than merely useless.
/// </remarks>
public record InternalDeleteByUserRequest(string CognitoSub, string UserId);

/// <summary>What the cascade removed, reported per table so a partial failure is diagnosable
/// from the response instead of the database.</summary>
public record InternalDeleteResponse(int Deleted, int DeletedDetails, int DeletedCarts);
