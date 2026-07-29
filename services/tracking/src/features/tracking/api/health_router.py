"""`GET /v1/health` — the liveness/readiness probe (JE-92).

## Bare path here, prefixed at the gateway

The service serves this **unprefixed** at `/v1/health`, while the gateway publishes
it as `/v1/tracking/health` and nginx rewrites the prefixed path down to this bare
one (`infra/modules/compute/nginx/nginx.conf`, marked HEALTH-ONLY there — the
rewrite must not be extended to functional routes). Users and Orders serve theirs
the same way.

The gateway prefix is not cosmetic. nginx's default `location /` proxies anything
unmatched to `users:3000`, so a bare `GET /v1/health` route at the GATEWAY would
fall through to that catch-all and return **Users'** 200 — a Tracking health probe
that reports healthy while never once reaching this service. That failure mode is
worse than a 404 because nothing would ever flag it. Hence: bare internally,
prefixed at the gateway.

## Unauthenticated, and shallow

No `x-user-id`, no API key — an ALB/Fargate probe carries neither. In FastAPI that
takes no allowlist: this router simply declares no auth dependency (contrast
Orders, whose middleware needs `PublicRoutes.IsPublic` to exempt it).

It also does **not** touch the database. This is a liveness check answering "is
this process up and serving HTTP"; folding a `SELECT 1` into it would make a
transient database blip cycle otherwise-healthy tasks, and the design specifies a
flat `200 {"status": "ok"}`.
"""

from __future__ import annotations

from fastapi import APIRouter, status

from src.features.tracking.api.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get(
    "/v1/health",
    status_code=status.HTTP_200_OK,
    summary="Liveness/readiness probe",
)
async def health() -> HealthResponse:
    """Return `200 {"status": "ok"}`.

    `async def` is correct here precisely because there is nothing blocking to do —
    no session, no query. Every other handler in this service is a plain `def`,
    since pymysql is a blocking driver.
    """
    return HealthResponse(status="ok")
