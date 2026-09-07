---
title: "Address Geocoding — Same-Origin Proxy Design"
type: spec
area: shared
status: active
created: 2026-09-06
updated: 2026-09-07
tags:
  - type/spec
  - area/shared
  - status/active
  - issue/JE-252
related:
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[2026-09-05-phone-input-country-flag]]"
  - "[[env-files]]"
  - "[[logging-context]]"
  - "[[openobserve-cloudwatch]]"
  - "[[linear-references]]"
  - "[[2026-09-07-a-dead-path-is-not-fail-closed-against-an-external-host]]"
propagates-to:
  - "[[openobserve-cloudwatch]]"
  - "[[env-files]]"
---

# Address Geocoding — Same-Origin Proxy Design

## Context

Checkout collects a delivery address by hand. OpenStreetMap-backed autocomplete can speed
that up, but the geocoding provider needs an API key that must never reach the browser — the
same same-origin-proxy shape [[2026-09-04-web-gateway-integration-design]] already established
for the API gateway, applied to a second, external upstream.

**Provider: Geoapify.** Free tier 3,000 requests/day, no credit card. Key obtained at
myprojects.geoapify.com.

## Decision 1 — the key is server-side only, appended by nginx

The browser calls same-origin `/geocode/?text=...`; `apps/web/nginx.conf`'s `location
/geocode/` proxies to `https://api.geoapify.com/v1/geocode/autocomplete?$args&apiKey=<key>`.
An `NG_APP_*` value is compiled into the bundle and readable in devtools, so a key there would
be public. This mirrors the existing `/v1/` gateway proxy: nothing in this repo sends CORS
headers, so same-origin proxying is the pattern throughout, per
[[2026-09-04-web-gateway-integration-design]].

## Decision 2 — fail CLOSED when the key is unset

With no key, the location returns **HTTP 503** with body
`{"error":"geocoding_disabled","detail":"Set GEOAPIFY_API_KEY in the CUSTOM box of
.env.local.web, then: docker compose up -d web"}`.

Rationale worth stating explicitly: calling Geoapify without a key returns **401 AND still
burns a request** against the 3,000/day quota. An unset key means the feature is off, not
broken. Implemented as two `map` blocks (`$geoapify_key`, `$geoapify_disabled`) because a
`map` is the only way to hold an envsubst result outside a location block.

## Decision 3 — the flag and the key are separate, and must be turned on together

`NG_APP_GEOCODE_ENABLED` (a build-time flag, default `false`, parsed in
`core/config/app-config.ts` as `geocodeEnabled`) controls whether the UI offers autocomplete;
`GEOAPIFY_API_KEY` (runtime, read by nginx from `.env.local.web`) controls whether the proxy
works. Offering an autocomplete that 503s on every keystroke is worse than not offering it.
Both need to be set for the feature to actually work end to end.

## Traps found at implementation time

These were verified against a live nginx and must not be rediscovered.

- **nginx has no escape for a literal `$`.** The gateway proxy path needs a literal
  `$default` stage segment, written as **`%24default`** (URL-encoded). This was initially
  specified wrongly and corrected only after a live check: `nginx: [emerg] unknown "default"
  variable`. This is the same trap already recorded for the gateway proxy in
  [[2026-09-04-web-gateway-integration-design]]; the geocode proxy inherits it because it also
  proxies through a variable path.
- **A `proxy_pass` containing a variable does not append the unmatched URI automatically** —
  `$request_uri` (gateway) and the explicit path + `$args` (geocode) are written out by hand.
- **An HTTPS upstream needs BOTH `proxy_ssl_server_name on;` and `proxy_set_header Host
  api.geoapify.com;`.** Without SNI, Cloudflare serves the wrong certificate and the handshake
  fails. With the client's `$host` (`localhost:3004`) the request never routes to the Geoapify
  vhost.
- **Keep the upstream in a variable.** `set $upstream "api.geoapify.com";` forces per-request
  DNS resolution; a literal host is resolved once at startup and goes stale.
- **`resolver ... ipv6=off` is required once an external host is proxied.** `127.0.0.11`
  forwards to the host's resolver, which answers for `api.geoapify.com` with both an A and an
  AAAA record. The container has no IPv6 route, so nginx occasionally picking the AAAA record
  fails the request with "Network is unreachable" — intermittently, depending on which record
  it selects. This trap is specific to the geocode proxy: the gateway proxy target is an
  internal Docker hostname with no AAAA record to pick.

## Privacy

The proxy strips `Authorization` and `Cookie` before forwarding — our Cognito token must
never reach a third party. On the client side this holds for a second, independent reason:
`authInterceptor`'s `isPublic()` returns true when `gatewayPath()` is null, and `/geocode/`
does not start with `/v1`, so no bearer token is attached in the first place.

## Observability — counting the free tier

`apps/web/nginx.conf` sets `access_log off` globally and re-enables it for `/geocode/` alone,
in a JSON `log_format` carrying `service_name: "web-geocode"` plus `severity_text`/
`severity_number` derived from `$status` via `map` blocks (5xx error, 4xx warn, else info) —
the shape `transform/parse_body` already parses, per [[logging-context]]. The web service uses
the Docker `fluentd` driver (`fluentd-async: "true"`) to reach the collector, per
[[openobserve-cloudwatch]].

**Worth recording as a contract:** the fluentd driver is only safe *because* static-file
logging is off — nginx's combined format has no `service_name`, so every static request would
land in the `unclassified` stream the pipeline exists to keep empty. Side effect: `docker
compose logs web` shows nothing for this service; the call count lives in OpenObserve's `logs`
stream under `service_name = web-geocode`.

## The `ng serve` twin — `apps/web/proxy.conf.mjs`

nginx is one half of the same-origin proxy; `ng serve` needs its own for local development
without a container, generated by `make env-file` into `apps/web/proxy.conf.mjs` (gitignored,
contract at `apps/web/proxy.conf.example.mjs`). The nginx `/v1/` route already forced this file
from JSON to a module for the gateway's own reasons (see
[[2026-09-04-web-gateway-integration-design]]); adding `/geocode/` is what actually requires
that module shape, since a declarative JSON proxy config cannot read `process.env` or a file to
obtain a secret at request time.

The module reads `GEOAPIFY_API_KEY` from `.env.local.web` — the same CUSTOM box nginx reads —
at request time, never interpolated into the generated file (an exported `GEOAPIFY_API_KEY` in
the environment wins, for a one-off override). The rendered `.mjs` is gitignored but still sits
on disk, and a key baked in at generation time would outlive every `make clean`; reading it live
avoids that.

Verified live (`ng serve`, after `make clean` + full `make bootstrap`):

| Route | Result |
|---|---|
| `/` | 200 (SPA) |
| `/v1/users/health` | 200 `{"status":"ok"}` |
| `/geocode/` no key | 503 `application/json`, `{"error":"geocoding_disabled",...}` |
| `/geocode/` with key | rewrites to `/v1/geocode/autocomplete?<original query>&apiKey=…` |

**Angular 21 uses Vite, not webpack** — the commonly-cited Angular proxy documentation
describes `webpack-dev-server` and is outdated for this version. The builder converts
webpack-shaped `pathRewrite` into Vite's `rewrite(path)`; Vite sets `req.url =
opts.rewrite(req.url)`, and `req.url` **includes the query string**, which is what makes
appending `&apiKey=` to it possible.

The first implementation of the "key unset" branch returned a dead path instead of ending the
response in-process, expecting a local 404; it did not get one — the request still left the
origin and came back with Cloudflare's HTML 503. The fix uses Vite's `bypass` to answer
`503 application/json` itself, matching nginx's body exactly. This generalizes beyond this repo:
see [[2026-09-07-a-dead-path-is-not-fail-closed-against-an-external-host]].

The `$default` asymmetry from the gateway proxy is now three-way: nginx must percent-encode it
as `%24default` (nginx has no escape for a literal `$`), while both the old JSON proxy config
and this `.mjs` module write `$default` plainly — Vite's `rewrite` performs no expansion, same
as the JSON config it replaced.

## Known limitation that names the feature

**OSM has no house numbers for Santo Domingo.** Therefore this is **street** autocomplete,
not full-address autocomplete: the suggestion fills street/city/state/postal code/country and
the user types the house number. Naming it otherwise would over-promise on every Dominican
address. This is a naming and UX constraint, not a bug to fix later.

## Caveat on measurement — stack-wide log ingestion gap (JE-253)

Verifying the log pipeline for this feature surfaced a **stack-wide** pre-existing defect: on
a long-running stack, no service's logs reach OpenObserve — the collector reports "Too old
data, only last 5 hours can be ingested" and drops thousands of records. This was confirmed
against Users too, so it is not geocode-specific; it is a property of
[[openobserve-cloudwatch]]'s pipeline under sustained uptime. Tracked as
[JE-253](https://linear.app/je-martinez/issue/JE-253) (High).

The consequence worth writing down: any call-count measurement taken from OpenObserve on a
stack that has been up for a while is unreliable until JE-253 is fixed — a low count there can
mean "few calls" or "the collector dropped them," and today there is no way to tell which from
the query alone.

## Status

Infra half shipped in `aad98b5` ("feat(infra): proxy Geoapify geocoding same-origin and count
the calls"), covering both the nginx container proxy and its `ng serve` twin
(`apps/web/proxy.conf.mjs`). The Angular street-autocomplete component that consumes this proxy
is being implemented separately, in parallel with this note; this spec describes the proxy
design only (both halves) and does not claim the UI side is done.

## Related

- [[2026-09-04-web-gateway-integration-design]] — the same-origin proxy pattern and the
  `$default` percent-encoding trap this design inherits; also documents the `ng serve` proxy
  module's role in the `/v1/` route.
- [[2026-09-05-phone-input-country-flag]] — sibling "evaluate before building" note from the
  same milestone.
- [[env-files]] — `GEOAPIFY_API_KEY` (CUSTOM box, `.env.local.web`) and `NG_APP_GEOCODE_ENABLED`
  (build-time) follow the generated-env-file convention this proxy depends on; also documents
  `apps/web/proxy.conf.mjs`/`proxy.conf.example.mjs`.
- [[logging-context]] — the shared log shape (`service_name`, `severity_text`/`_number`,
  `duration_ms`) the `/geocode/` access log follows.
- [[openobserve-cloudwatch]] — the fluentd-to-OpenObserve pipeline this feature's call count is
  observed through, and the JE-253 ingestion gap that limits trusting it on a stale stack.
- [[linear-references]] — convention this note follows for referencing JE-252/JE-253 without
  mirroring them.
- [[2026-09-07-a-dead-path-is-not-fail-closed-against-an-external-host]] — the `bypass`/dead-path
  lesson found implementing this proxy's `ng serve` twin.
