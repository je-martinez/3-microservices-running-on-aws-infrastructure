"""The REST surface (Phase D).

Three routers, one per auth scheme — `health_router` (none), `trackings_router`
(gateway `x-user-id`), `carrier_router` (carrier API key). The split is by
CREDENTIAL, not by path: the reads and the carrier PUT share a `/v1/trackings`
prefix and must never share a dependency.
"""
