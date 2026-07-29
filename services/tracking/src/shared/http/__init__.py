"""Transport-level HTTP concerns shared by the REST surface (Phase D).

Auth lives here, split into two modules on purpose — `identity.py` for the
gateway-injected `x-user-id` on the user-scoped reads, `carrier_auth.py` for the
external carrier key on the status PUT. They are separate trust domains and never
appear on the same request.
"""
