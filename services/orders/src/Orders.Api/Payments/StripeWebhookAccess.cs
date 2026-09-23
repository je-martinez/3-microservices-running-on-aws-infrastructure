using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Primitives;

namespace Orders.Api.Payments;

/// <summary>
/// The two layers Orders' Stripe webhook checks before it reads the body, in this order: Stripe's
/// source-IP allowlist, then the URL token. The <c>Stripe-Signature</c> check follows them.
/// </summary>
/// <remarks>
/// CONTRACT: Both layers live in the service, not at the edge — nginx is local-only and API
/// Gateway HTTP APIs have no WAF. A missing or invalid setting fails closed (503), never open.
/// See [[2026-09-19-stripe-payments-design]]
/// </remarks>
public sealed class StripeWebhookAccess
{
    private readonly byte[]? _token;
    private readonly IReadOnlyList<IPNetwork>? _allowedNetworks;
    private readonly int _trustedProxyHops;

    /// <param name="urlToken">
    /// <c>STRIPE_WEBHOOK_URL_TOKEN</c>. CONTRACT: A secret — never log it or put it on a span.
    /// </param>
    /// <param name="allowedNetworks">Null when the allowlist is unset or invalid.</param>
    /// <param name="trustedProxyHops">Proxies that append to X-Forwarded-For; 0 reads the socket.</param>
    public StripeWebhookAccess(string? urlToken, IReadOnlyList<IPNetwork>? allowedNetworks, int trustedProxyHops)
    {
        _token = string.IsNullOrWhiteSpace(urlToken) ? null : Encoding.UTF8.GetBytes(urlToken);
        _allowedNetworks = allowedNetworks;
        _trustedProxyHops = trustedProxyHops;
    }

    public bool TokenConfigured => _token is not null;

    public bool AllowlistConfigured => _allowedNetworks is not null && _trustedProxyHops >= 0;

    /// <summary>
    /// Reads <c>STRIPE_WEBHOOK_URL_TOKEN</c>, <c>STRIPE_WEBHOOK_ALLOWED_CIDRS</c> and
    /// <c>STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS</c>; <paramref name="problems"/> names each setting
    /// that leaves the webhook answering 503.
    /// </summary>
    public static StripeWebhookAccess FromConfiguration(IConfiguration config, out IReadOnlyList<string> problems)
    {
        var found = new List<string>();
        var token = config["STRIPE_WEBHOOK_URL_TOKEN"];
        if (string.IsNullOrWhiteSpace(token))
        {
            found.Add("STRIPE_WEBHOOK_URL_TOKEN is not set");
        }

        var networks = ParseAllowlist(config["STRIPE_WEBHOOK_ALLOWED_CIDRS"]);
        if (networks is null)
        {
            found.Add("STRIPE_WEBHOOK_ALLOWED_CIDRS is not set or holds an entry that is not an IP or CIDR");
        }

        var hopsRaw = config["STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS"];
        var hops = 0;
        if (!string.IsNullOrWhiteSpace(hopsRaw) && (!int.TryParse(hopsRaw, out hops) || hops < 0))
        {
            hops = -1;
            found.Add("STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS is not an integer >= 0");
        }

        problems = found;
        return new StripeWebhookAccess(token, networks, hops);
    }

    /// <summary>Comma-separated IPs or CIDRs; null when blank or when ANY entry is invalid.</summary>
    /// <remarks>WHY: One typo must not silently shrink the allowlist to its valid remainder.</remarks>
    public static IReadOnlyList<IPNetwork>? ParseAllowlist(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var networks = new List<IPNetwork>();
        foreach (var entry in raw.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            if (IPNetwork.TryParse(entry, out var network))
            {
                networks.Add(network);
            }
            else if (IPAddress.TryParse(entry, out var address))
            {
                var single = Normalize(address);
                networks.Add(new IPNetwork(single, single.GetAddressBytes().Length * 8));
            }
            else
            {
                return null;
            }
        }

        return networks.Count == 0 ? null : networks;
    }

    /// <summary>
    /// The delivering client: the socket address with zero trusted hops, otherwise the
    /// X-Forwarded-For entry that many positions from the right. Null when absent or unparseable.
    /// </summary>
    /// <remarks>
    /// CONTRACT: Count from the RIGHT. Entries left of the trusted proxies' are client-controlled,
    /// so reading the leftmost lets any caller claim a Stripe address.
    /// See [[2026-09-19-stripe-payments-design]]
    /// </remarks>
    public IPAddress? ResolveClientIp(IPAddress? remoteAddress, StringValues forwardedFor)
    {
        if (_trustedProxyHops == 0)
        {
            return remoteAddress is null ? null : Normalize(remoteAddress);
        }

        var entries = forwardedFor
            .SelectMany(value => (value ?? string.Empty).Split(','))
            .Select(entry => entry.Trim())
            .ToList();
        if (_trustedProxyHops < 1 || entries.Count < _trustedProxyHops)
        {
            return null;
        }

        return IPAddress.TryParse(entries[^_trustedProxyHops], out var address) ? Normalize(address) : null;
    }

    public bool IsAllowed(IPAddress clientIp) =>
        _allowedNetworks is not null && _allowedNetworks.Any(network => network.Contains(clientIp));

    /// <summary>Constant-time comparison of the presented URL token with the configured one.</summary>
    /// <remarks>
    /// CONTRACT: No early return on a length mismatch — the candidate is padded to the expected
    /// length and both results are combined with a non-short-circuit <c>&amp;</c>.
    /// </remarks>
    public bool TokenMatches(string? presented)
    {
        if (_token is null)
        {
            return false;
        }

        var candidate = Encoding.UTF8.GetBytes(presented ?? string.Empty);
        var padded = new byte[_token.Length];
        candidate.AsSpan(0, Math.Min(candidate.Length, padded.Length)).CopyTo(padded);
        return CryptographicOperations.FixedTimeEquals(padded, _token) & candidate.Length == _token.Length;
    }

    // WHY: A dual-stack socket reports an IPv4 peer as ::ffff:a.b.c.d, which no IPv4 CIDR contains.
    private static IPAddress Normalize(IPAddress address) =>
        address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address;
}
