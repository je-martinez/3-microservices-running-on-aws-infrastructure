---
title: "A dead path is not fail-closed when the target is an external host"
type: lesson
area: shared
status: active
created: 2026-09-07
updated: 2026-09-07
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
  - issue/JE-252
related:
  - "[[2026-09-06-address-geocoding-proxy-design]]"
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[env-files]]"
---

# A dead path is not fail-closed when the target is an external host

## Finding

A proxy's "fail closed on missing config" branch is not automatically safe just because it
avoids forwarding the real request. If the fallback still constructs a target on an **external**
host, the caller's request leaves the origin anyway — it just fails against the wrong service,
and gets that service's error shape instead of ours.

## Real occurrence

Implementing the `ng serve` twin of the Geoapify proxy (`apps/web/proxy.conf.mjs`, per
[[2026-09-06-address-geocoding-proxy-design]]), the first cut of the "key unset" branch pointed
the proxy at a path with no `apiKey` query param, expecting Vite to answer a local 404 before
ever reaching the network. It did not: the request still left the dev server, reached
Cloudflare in front of `api.geoapify.com`, and came back as an **HTML 503** — a page the caller
cannot parse as JSON, and a payload that reveals nothing about *our* app being the reason the
feature is off. This was caught only by testing the keyless path live, not by reading the code.

## Root cause

Vite's `http-proxy-middleware` config only stops proxying a request when the `bypass` hook
writes to the response object AND ends it — verified in the installed Vite 7.3.6 source
(`config.js`, around line 22065), which checks `res.writableEnded` after calling `bypass` and
proxies the request unless that check is true. A `bypass` that merely returns a falsy value or a
modified path is not enough to prevent the proxy step; only an in-process response ends it.

## Fix

`bypass` now checks for the key and, when absent, calls `res.writeHead(503, {'Content-Type':
'application/json'})` and `res.end(JSON.stringify({error: 'geocoding_disabled', ...}))` directly,
returning `true` to signal it already handled the response. This answers the same
`503 application/json` shape nginx serves for the container path — no request ever reaches
Geoapify when the key is unset.

## Generalization

When a fallback branch's job is "fail without leaking the request anywhere," the design must
end the response in-process. A "dead" or otherwise unreachable path is not fail-closed once the
target of that path resolves to a host outside your control — the platform proxying the request
does not know the destination is intentionally wrong, and will happily deliver it there.

## Related

- [[2026-09-06-address-geocoding-proxy-design]] — the geocode proxy design this bug was found
  implementing (nginx side); its `ng serve` twin is documented in
  [[2026-09-04-web-gateway-integration-design]]'s proxy section.
- [[2026-09-04-web-gateway-integration-design]] — the same-origin proxy pattern this fallback
  branch belongs to, and where the `ng serve` proxy implementation is now described.
- [[env-files]] — `GEOAPIFY_API_KEY`'s generated-env-file convention, the input this fallback
  reacts to being absent.
