import { describe, expect, it } from "vitest";
import {
  isAllowedSource,
  parseAllowedSources,
  resolveClientIp,
} from "#shared/http/source-ip";
import { urlTokenMatches } from "#payment-methods/webhooks/webhook-url-token";

describe("resolveClientIp", () => {
  it("uses the socket remote address when hops = 0, ignoring X-Forwarded-For", () => {
    expect(resolveClientIp("10.1.2.3", "3.18.12.63", 0)).toBe("10.1.2.3");
  });

  it("normalizes an IPv4-mapped IPv6 socket address", () => {
    expect(resolveClientIp("::ffff:3.18.12.63", undefined, 0)).toBe("3.18.12.63");
    expect(resolveClientIp("::FFFF:3.18.12.63", undefined, 0)).toBe("3.18.12.63");
  });

  it("keeps a real IPv6 socket address", () => {
    expect(resolveClientIp("::1", undefined, 0)).toBe("::1");
  });

  it("takes the X-Forwarded-For entry `hops` positions from the right", () => {
    const xff = "6.6.6.6, 3.18.12.63, 10.0.0.5";
    expect(resolveClientIp("10.0.0.9", xff, 1)).toBe("10.0.0.5");
    expect(resolveClientIp("10.0.0.9", xff, 2)).toBe("3.18.12.63");
    expect(resolveClientIp("10.0.0.9", xff, 3)).toBe("6.6.6.6");
  });

  it("reads a repeated X-Forwarded-For header as one list", () => {
    expect(resolveClientIp("10.0.0.9", ["6.6.6.6", "3.18.12.63"], 1)).toBe("3.18.12.63");
  });

  it("normalizes an IPv4-mapped entry in X-Forwarded-For", () => {
    expect(resolveClientIp("10.0.0.9", "::ffff:3.18.12.63", 1)).toBe("3.18.12.63");
  });

  it("is unparseable when X-Forwarded-For is missing or shorter than hops", () => {
    expect(resolveClientIp("10.0.0.9", undefined, 1)).toBeUndefined();
    expect(resolveClientIp("10.0.0.9", "3.18.12.63", 2)).toBeUndefined();
  });

  it("is unparseable when the selected entry is not an IP", () => {
    expect(resolveClientIp("10.0.0.9", "not-an-ip", 1)).toBeUndefined();
    expect(resolveClientIp("10.0.0.9", "3.18.12.63:443", 1)).toBeUndefined();
    expect(resolveClientIp(undefined, undefined, 0)).toBeUndefined();
  });
});

describe("parseAllowedSources / isAllowedSource", () => {
  const allow = parseAllowedSources("3.18.12.63, 10.0.0.0/8 ,::1,2001:db8::/32");

  it.each(["3.18.12.63", "10.200.1.1", "::1", "2001:db8::42"])("allows %s", (ip) => {
    expect(isAllowedSource(ip, allow)).toBe(true);
  });

  it.each(["3.18.12.64", "11.0.0.1", "::2", "2001:db9::1"])("rejects %s", (ip) => {
    expect(isAllowedSource(ip, allow)).toBe(false);
  });

  it("matches an IPv4-mapped entry against an IPv4 client", () => {
    expect(isAllowedSource("3.18.12.63", parseAllowedSources("::ffff:3.18.12.63"))).toBe(true);
  });

  it.each(["", "   ", "10.0.0.0/33", "999.1.1.1", "10.0.0.0/x", "::1/129", "a,b"])(
    "rejects the malformed list %j",
    (raw) => {
      expect(() => parseAllowedSources(raw)).toThrow();
    },
  );
});

describe("urlTokenMatches", () => {
  const token = "tok_0123456789abcdef0123456789abcdef";

  it("matches the exact token", () => {
    expect(urlTokenMatches(token, token)).toBe(true);
  });

  it.each(["", "tok", `${token}x`, token.toUpperCase(), token.slice(0, -1) + "0"])(
    "rejects %j",
    (provided) => {
      expect(urlTokenMatches(provided, token)).toBe(false);
    },
  );

  it("rejects a missing token", () => {
    expect(urlTokenMatches(undefined, token)).toBe(false);
  });
});
