"""gRPC transport plumbing — OUTBOUND only.

The generated `users.v1` stubs and the client that calls them. Tracking serves no
gRPC: its server, the inbound `x-api-key` interceptor and the `tracking.v1` stubs
were removed in JE-108 when creation moved to `POST /v1/trackings/init-tracking`
and the unscoped reads were replaced by user-scoped REST ones.
"""
