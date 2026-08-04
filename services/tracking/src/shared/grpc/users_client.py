"""OUTBOUND gRPC client to the Users service (JE-101).

The Python counterpart of Orders'
`src/Orders.Infrastructure/Grpc/UserDirectoryGrpcClient.cs`, and — since JE-108
removed the served `tracking.v1.Tracking` surface — the ONLY gRPC left in this
service. Everything under `shared/grpc/` now points one way: outward, calling
`users.v1.Users`. It exists for exactly one question — "which internal `usr_` id
belongs to this Cognito sub?" — because the gateway only ever hands this service a
sub (see `shared/http/identity.py`) while a persisted `tracking.user_id` is a
`usr_` id.

## `NOT_FOUND` is an answer, not an error

Users answers `NOT_FOUND` for a sub it has never seen. That is a perfectly ordinary
outcome — a token minted for a Cognito user whose record was never created, or was
deleted — and it maps to `None` here rather than propagating an `RpcError`. Two
reasons to convert at this boundary instead of upstream:

* An `RpcError` carries the transport's vocabulary (status codes, trailing
  metadata, a channel) into handlers that have no business knowing this service
  talks gRPC at all. `None` is the domain fact: no such user.
* It keeps "unknown user" distinguishable from "Users is down". Every OTHER status
  — `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `UNAUTHENTICATED` — is deliberately left to
  propagate, because a caller must not treat an outage as "this user doesn't
  exist" and, say, write a row attributing the shipment to nobody. Orders draws the
  line in the same place.

## Auth

Every call attaches the shared internal `x-api-key`
([[ADR-0003-grpc-inter-service]]) as call metadata — `GRPC_API_KEY`, the one
internal trust domain Users and Orders share. Tracking now only ever PRESENTS it;
it validates no inbound key of its own since the served surface went away. It is
passed per-call rather than baked into the channel so the channel stays a plain,
inspectable object and the credential appears at exactly the place it is used.

## Blocking on purpose

This is the SYNC grpcio API, not `grpc.aio`, matching the rest of the service: the
database driver is blocking pymysql and every DB-touching FastAPI handler is a
plain `def` running in the threadpool. An async client here would be the one
awaitable thing in an otherwise synchronous request path, and would have to be
driven from a thread that has no event loop.

## Never log a `UserResponse`

The response now carries the user's address and email — PII, per the .proto's own
warning and [[logging-context]]. Nothing here logs the message, and nothing that
receives a `ResolvedUser` should either.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import grpc

from src.shared.config.settings import get_settings
from src.shared.grpc.generated import users_pb2, users_pb2_grpc

#: Metadata key carrying the shared internal secret. gRPC lowercases metadata keys
#: on the wire, so this must be lowercase to match what Users reads it as. Declared
#: here rather than imported: the inbound interceptor that used to own this
#: constant was removed with the served surface (JE-108), and the only thing left
#: that needs the key is this client.
API_KEY_METADATA_KEY = "x-api-key"

#: Seconds to wait for Users before giving up. A gRPC call with NO deadline waits
#: forever, which in a request path means a hung Users pins a worker thread until
#: something else times out. Short because the call is a single indexed lookup: if
#: it has not answered in two seconds it is not about to.
DEFAULT_TIMEOUT_SECONDS = 2.0


@dataclass(frozen=True, slots=True)
class ResolvedUser:
    """The subset of `users.v1.UserResponse` this service has a use for.

    A domain value, not the proto message, so nothing downstream imports the
    generated module or holds a reference into gRPC's object graph.

    Still deliberately NOT carrying the address, even though `UserResponse.address`
    exists: no caller in this service needs it. The REST creation endpoint takes
    `shipping_address` in the request body, so pulling the address through here
    would be an unused field carrying PII around — see [[logging-context]] on
    keeping PII to the places that genuinely need it. Add it when something
    actually consumes it, not before.

    `email` IS carried, as of the events-pipeline milestone, and it is the
    "something actually consumes it" case this docstring reserved. The
    `TRACKING_STATUS_CHANGED` publisher must put the recipient's address in the
    event payload — the pipeline's handler
    (`functions/events-pipeline/src/handlers/tracking-status-changed.ts`) rejects
    a payload without `email` as a PERMANENT error, so the email would never be
    sent. Tracking persists no email of its own, and Users is the only place that
    holds one, so this RPC is where it has to come from.

    It is PII exactly like the address: never log a `ResolvedUser`, and log
    `email_hash` rather than this field (see the module docstring's "Never log a
    `UserResponse`").
    """

    #: The internal `usr_` id — what `tracking.user_id` stores.
    internal_id: str
    #: The Cognito `sub` Users has on file. Echoed back for the caller to sanity
    #: check against the sub it asked with; the RPC accepts either identifier.
    cognito_sub: str
    #: The user's email address — PII, consumed ONLY by the events publisher to
    #: address the notification. Never logged, never returned over REST.
    #:
    #: proto3 has no null, so an absent email arrives as `""`. Normalized to
    #: `None` here rather than propagating the empty string: `""` would be
    #: published as a valid-looking payload field and rejected downstream by the
    #: handler's `z.string().email()`, whereas `None` lets the publisher decide
    #: (and log a `reason`) before anything reaches the queue.
    email: str | None = None


class UsersGrpcClient:
    """Resolves a Cognito sub to an internal user through `users.v1.Users`.

    Holds a channel it does NOT own by default: `for_target()` builds one, and the
    process-wide instance keeps it for the life of the process. A channel is a
    connection pool — building one per call would pay TCP + HTTP/2 setup on every
    request and leak sockets under load.
    """

    def __init__(
        self,
        *,
        channel: grpc.Channel,
        api_key: str,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        if not api_key:
            # An empty key would be sent as an empty `x-api-key` and rejected by
            # Users with UNAUTHENTICATED at runtime — a failure much better
            # detected at construction, where the misconfiguration actually is.
            raise ValueError("api_key must not be empty")
        self._channel = channel
        self._stub = users_pb2_grpc.UsersStub(channel)
        self._api_key = api_key
        self._timeout = timeout

    @classmethod
    def for_target(
        cls,
        target: str,
        *,
        api_key: str,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> UsersGrpcClient:
        """Build a client over a new insecure channel to `target`.

        Insecure because this hop is inside the private network and is
        authenticated by the shared key ([[ADR-0003-grpc-inter-service]]).
        """
        return cls(
            channel=grpc.insecure_channel(normalize_target(target)),
            api_key=api_key,
            timeout=timeout,
        )

    def close(self) -> None:
        """Close the underlying channel. Idempotent, per grpcio."""
        self._channel.close()

    def resolve(self, identifier: str) -> ResolvedUser | None:
        """Look up a user by Cognito sub (or internal id), or None if unknown.

        `GetUserById` accepts BOTH identifiers — the .proto says so and Users'
        handler implements it — so this takes the neutral name `identifier`
        rather than pretending the argument must be one or the other.

        Only `NOT_FOUND` becomes None; every other status propagates as the
        `RpcError` grpcio raised. See the module docstring.
        """
        try:
            response = self._stub.GetUserById(
                users_pb2.GetUserByIdRequest(id=identifier),
                metadata=((API_KEY_METADATA_KEY, self._api_key),),
                timeout=self._timeout,
            )
        except grpc.RpcError as error:
            # grpc.Call (what the sync API raises) exposes .code(); the bare
            # RpcError base does not, hence the guarded read rather than a blind
            # `error.code()` that would itself raise while handling an error.
            code = error.code() if isinstance(error, grpc.Call) else None
            if code is grpc.StatusCode.NOT_FOUND:
                return None
            raise
        return ResolvedUser(
            internal_id=response.id,
            cognito_sub=response.cognito_sub,
            # proto3 sends an absent string as "", never null. Normalized to None
            # so "Users has no email on file" is one value, not two — see the
            # field's docstring.
            email=response.email or None,
        )


def normalize_target(target: str) -> str:
    """Strip an `http://`/`https://` scheme from a gRPC target.

    grpcio wants a bare `host:port`; a value carrying a scheme resolves to a
    nonsense authority and fails at connect time with a DNS error that names
    neither the setting nor the cause. Orders' .NET channel requires the scheme
    (`GrpcChannel.ForAddress`), so the shared `USERS_GRPC_URL` value legitimately
    has one — accepting both forms here means the two services can read the exact
    same environment variable instead of needing two spellings of one address.
    """
    for scheme in ("http://", "https://"):
        if target.startswith(scheme):
            return target[len(scheme) :]
    return target


@lru_cache(maxsize=1)
def _cached_client(target: str, api_key: str) -> UsersGrpcClient:
    """One client (hence one channel) per process, keyed on the PRIMITIVES.

    Keyed on the values rather than on `Settings` for the reason recorded in
    `shared/db/engine.py`: pydantic's `BaseSettings` is unhashable, so an
    `lru_cache` taking a settings object raises `TypeError` on its first call — a
    failure that no test binding its own client would ever see.
    """
    return UsersGrpcClient.for_target(target, api_key=api_key)


def shared_users_client() -> UsersGrpcClient:
    """The process-wide Users client, built lazily from settings.

    Lazy, not module-level, so importing this module does not open a channel (nor
    require a valid environment) — the same rule the rest of the service follows.
    """
    settings = get_settings()
    return _cached_client(settings.users_grpc_url, settings.grpc_api_key)
