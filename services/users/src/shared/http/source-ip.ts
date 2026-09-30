import { BlockList, isIP } from "node:net";

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function normalizeIp(raw: string): string | undefined {
  const trimmed = raw.trim();
  const mapped = IPV4_MAPPED.exec(trimmed);
  const ip = mapped ? mapped[1]! : trimmed;
  return isIP(ip) === 0 ? undefined : ip;
}

function family(ip: string): "ipv4" | "ipv6" {
  return isIP(ip) === 4 ? "ipv4" : "ipv6";
}

// CONTRACT: With hops = 0 the socket address is the client and X-Forwarded-For
// is ignored — a caller writes that header freely, so trusting it without a
// proxy in front lets anyone claim a Stripe IP. With hops = N the client is the
// entry N positions from the right, the one the outermost trusted proxy
// appended. Returns undefined when that entry is absent or not an IP.
// See [[2026-09-19-stripe-payments-design]]
export function resolveClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  hops: number,
): string | undefined {
  if (hops === 0) return remoteAddress === undefined ? undefined : normalizeIp(remoteAddress);

  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  if (!header) return undefined;
  const entries = header.split(",");
  const entry = entries[entries.length - hops];
  return entry === undefined ? undefined : normalizeIp(entry);
}

// Throws on any malformed entry so a typo fails at boot (env schema) instead of
// rejecting every delivery.
export function parseAllowedSources(raw: string): BlockList {
  const list = new BlockList();
  const entries = raw.split(",").map((e) => e.trim());
  if (entries.every((e) => e === "")) throw new Error("allowlist is empty");

  for (const entry of entries) {
    const [address, prefix, ...rest] = entry.split("/");
    const ip = address === undefined ? undefined : normalizeIp(address);
    if (ip === undefined || rest.length > 0) throw new Error(`invalid allowlist entry: ${entry}`);
    if (prefix === undefined) {
      list.addAddress(ip, family(ip));
      continue;
    }
    const bits = Number(prefix);
    const max = family(ip) === "ipv4" ? 32 : 128;
    if (!/^\d+$/.test(prefix) || bits > max) throw new Error(`invalid allowlist entry: ${entry}`);
    list.addSubnet(ip, bits, family(ip));
  }
  return list;
}

export function isAllowedSource(ip: string, allowed: BlockList): boolean {
  return allowed.check(ip, family(ip));
}
