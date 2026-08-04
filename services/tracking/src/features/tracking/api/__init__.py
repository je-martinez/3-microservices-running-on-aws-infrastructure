"""The REST surface (Phase D).

Routers are split by CREDENTIAL, not by path — `health_router` (none),
`trackings_router` / `init_tracking_router` / `e2e_router` (gateway `x-user-id`),
`carrier_router` (carrier API key). Four of them share the `/v1/trackings` prefix
and must never share a dependency.

`e2e_router` is the one that is CONDITIONALLY mounted: `src/main.py` includes it
only under `E2E_TESTING_ENABLED`, so in a production runtime the route does not
exist at all.
"""
