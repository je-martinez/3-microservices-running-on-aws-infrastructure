---
title: "A variable proxy_pass target skips nginx's trailing-slash prefix stripping"
type: lesson
area: shared
status: active
created: 2026-09-20
updated: 2026-09-20
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
related:
  - "[[browser-rum]]"
  - "[[2026-09-19-web-rum-integration-design]]"
  - "[[2026-09-06-address-geocoding-proxy-design]]"
  - "[[local-dev]]"
---

# A variable proxy_pass target skips nginx's trailing-slash prefix stripping

## Finding

A new same-origin proxy location for the OTel collector was written as
`proxy_pass http://$upstream/;` — a trailing slash, which for a **literal** `proxy_pass` target
strips the matched `location` prefix from the forwarded URI. Requests reached the collector with
the `/otlp` prefix still attached and got a `404` back from the collector's own server, not from
nginx — the request had left the nginx layer successfully, which is what made the failure look
like a collector-side problem at first.

## Mechanism

nginx's trailing-slash prefix replacement is a **static** substitution: it is performed against
the literal, configured URI string at config-load time. When the `proxy_pass` target contains a
variable (`$upstream`, `$otlp_collector`, …), the final URL is not known until request time, so
nginx cannot perform that substitution and falls back to forwarding `$request_uri` completely
unchanged — trailing slash present or not. The trailing slash is not wrong syntax; it is simply
inert once a variable is in the target.

## Why the variable is not optional here

The OTel collector sits behind a docker compose profile and is frequently not running when nginx
starts. A **literal** `proxy_pass` target makes nginx fail to **start** on an unresolvable
upstream, not merely fail the individual request; a variable target plus a server-level
`resolver` defers DNS resolution to request time, so nginx starts cleanly and only the request
using the collector fails while it is down. The variable is load-bearing for that reason, so the
trailing-slash shortcut simply cannot be relied on alongside it — the prefix must be stripped
explicitly.

## The corroboration worth recording

`apps/web/nginx.conf`'s pre-existing `/v1/` gateway proxy already documents the mirror image of
this same quirk: because its `proxy_pass` target is also a variable (`$gateway`), it must
**append** `$request_uri` explicitly in the target string, precisely because a variable target
does not append the unmatched URI on its own either. One nginx behavior — "no URI manipulation
happens automatically once the target is a variable" — produces two opposite-looking symptoms
depending on which manipulation (stripping vs. appending) the location needs.

## How to apply

- With a variable `proxy_pass` target, strip a location prefix explicitly:
  `rewrite ^/<prefix>/(.*)$ /$1 break;` before the `proxy_pass` line. Do not rely on a trailing
  slash on the target to do it.
- **Ordering matters**: `set $upstream ...;` must come **before** the `rewrite ... break;`,
  because `break` ends rewrite-module processing for that request — a `set` placed after it never
  runs, and nginx logs "using uninitialized variable" and answers `500`.
- When adding a same-origin proxy `location` in this repo, check whether the target needs its
  prefix **stripped** or the unmatched URI **appended**, and handle whichever applies explicitly
  — never assume the trailing slash on a `proxy_pass` target does either once that target is a
  variable.

## Related

- [[browser-rum]] — the RUM convention this proxy exists to support (OTel export path).
- [[2026-09-19-web-rum-integration-design]] — the design that added the `/otlp/` proxy location.
- [[2026-09-06-address-geocoding-proxy-design]] — the repo's other same-origin proxy, which
  documents the append-side mirror of this same quirk for its own variable target.
- [[local-dev]] — local nginx/compose conventions this proxy runs under.
