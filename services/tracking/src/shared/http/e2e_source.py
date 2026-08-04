"""The `x-e2e-source` request header — the E2E fixture tag (JE-111).

A tracking created by the end-to-end suite carries the tag `E2E_SOURCE_TAG`
(`"E2E Source"`, defined in `domain/models.py` — it is a persisted value, so it
belongs with the model rather than with the header that asks for it), and `DELETE
/v1/trackings/e2e-cleanup` deletes exactly the rows carrying it. This dependency
decides whether the request in hand is asking for that tag.

## Why the tag, and not the caller

The teardown runs once, globally, at the end of a suite — it has no user session
and sends no `x-user-id`. A cleanup scoped to the calling user could therefore
never be invoked by it. Tagging the row at creation moves the decision to the one
moment an identity IS present, and leaves the teardown a single unscoped
predicate. Users settled on exactly this (`user.tags` contains `"E2E Source"`,
`http/e2e-cleanup.ts`), and the three services should not each invent their own
notion of "a row the harness made".

## The flag is half of the condition, and it is the security half

The header alone must NOT be enough:

    e2e_source = header_says_true AND E2E_TESTING_ENABLED

Without the conjunction, any client anywhere could tag its own rows by sending one
header — and while a tag is harmless on its own, it is the exact predicate a mass
soft-delete endpoint selects on. In an environment where the flag is on but the
caller is untrusted, self-tagging would let a client enlist its rows for deletion
by somebody else's teardown. The flag is what confines the whole mechanism to
environments that deliberately opted into the harness. Users writes the identical
conjunction (`headerFlag && env.E2E_TESTING_ENABLED`, `http/routes.ts`).

Note the two halves fail in the same safe direction: with the flag off the tag is
never applied AND the cleanup route is not mounted at all (`src/main.py`), so
neither half of the mechanism exists in production.

## Only the exact string `"true"`

Same rule as `x-test-mode`, and for the same reason — a flag that switches on for
several spellings is one a caller enables by accident. Case-insensitive, nothing
more: no `1`, no `yes`. Never raises: an unrecognized value means "not an E2E
row", never a `400`, because failing the creation of a real shipment over a
malformed test-harness header would be the worse trade.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header

from src.shared.config.settings import e2e_testing_enabled

#: The header the harness (and Orders, forwarding it) sends.
E2E_SOURCE_HEADER = "x-e2e-source"

#: The ONE value that activates it (compared case-insensitively).
E2E_SOURCE_ACTIVE_VALUE = "true"


def parse_e2e_source(
    x_e2e_source: Annotated[str | None, Header(alias=E2E_SOURCE_HEADER)] = None,
) -> bool:
    """Whether this request's row should be tagged as an E2E fixture.

    Both halves of the condition are evaluated here rather than in the handler, so
    a second endpoint that ever wants the tag cannot acquire the header check
    without the flag check that makes it safe.

    The flag is read through `e2e_testing_enabled()` — the environment directly,
    not `get_settings()` — for the reason that function documents: this must not
    make a request depend on a fully-valid environment. It is also the same
    function `create_app` gates the cleanup route on, so the tag and the route that
    consumes it can never disagree about whether the harness is enabled.
    """
    if x_e2e_source is None:
        return False
    if x_e2e_source.strip().lower() != E2E_SOURCE_ACTIVE_VALUE:
        return False
    return e2e_testing_enabled()


#: Reusable annotation for handlers that may tag the row they create.
E2eSource = Annotated[bool, Depends(parse_e2e_source)]
