# Tracking service — FastAPI + uvicorn on Python 3.12.
# Build context: services/tracking (this directory) — NOT the repo root, unlike
# Users and Orders. Tracking needs nothing from outside its own tree: the Users
# gRPC stubs generated from proto/users.proto are COMMITTED under
# src/shared/grpc/generated/, so the .proto is not read at build time and not read
# at runtime either (contrast Users, whose gRPC server loads /app/proto/users.proto
# at boot and crashes with ENOENT if the Dockerfile forgets to copy it — see the
# comment on that COPY). `scripts/generate_grpc_stubs.py` regenerates the stubs on
# a developer machine; the image never runs it and needs no protoc.
#
# Multi-stage: `builder` installs the RUNTIME-only requirements into a virtualenv;
# `runtime` copies that finished venv and the source, and runs uvicorn as a
# non-root user. The venv is the Python analogue of Users' pruned node_modules — it
# is what lets the final image carry the dependency tree WITHOUT pip's build
# machinery, wheel cache, or the dev/test toolchain (pytest, ruff, httpx,
# grpcio-tools + its bundled protoc), none of which the process ever imports.
#
# Local dev runs via docker-watch (see root docker-compose.yml `develop.watch`),
# which SYNCS ./src into /app/src. The `--reload` that makes a synced file actually
# take effect is added by compose's `command:` override, NOT here: a reload watcher
# baked into the image CMD would follow this image into any deployment.

FROM python:3.12-slim AS base
# PYTHONDONTWRITEBYTECODE: no .pyc next to a read-only/synced source tree.
# PYTHONUNBUFFERED: stdout reaches the fluentd log driver line-by-line instead of
# sitting in a 4 KB buffer — the logging convention ([[logging-context]]) assumes
# every line is shipped promptly.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app

# ── builder stage: resolve + install runtime dependencies into a venv ─────────
FROM base AS builder
# Own venv rather than the system site-packages: the runtime stage then copies one
# self-contained directory and inherits nothing else from this stage.
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
# Requirements FIRST, source second — a code change must not reinstall the
# dependency tree. Only requirements-runtime.txt is copied (and installed):
# requirements.txt `-r`-includes it and adds the dev/test toolchain, which has no
# business in a runtime image. Copying just the runtime file also means a
# dev-dependency bump does not invalidate this layer.
COPY requirements-runtime.txt ./
# --no-cache-dir: the wheel cache would be dead weight in this stage's layers and
# is never reused (the venv, not the cache, is what `runtime` copies).
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements-runtime.txt

# ── runtime stage: venv + source, non-root, uvicorn ──────────────────────────
FROM base AS runtime
# Finished venv from the builder — no pip build machinery, no dev dependencies.
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Unprivileged user. A compromised web process should not be able to write to the
# image, and the fixed uid/gid keeps ownership stable for the docker-watch sync
# target below. Created before the COPY so the source lands owned by it.
RUN groupadd --gid 1001 tracking \
    && useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin tracking

# Application code. Copied AFTER the dependency install so editing a handler
# rebuilds one small layer.
# - src/     — the application package; `src.main:app` is the uvicorn target.
# - alembic/, alembic.ini — migrations, run against the container's own
#   dependencies (`alembic upgrade head`, CLAUDE.md §2). They ship in the image so
#   a migration never needs a second toolchain.
# - pyproject.toml — tool config only (pytest/ruff); harmless and keeps
#   `ruff check .` usable for a one-off exec into a running container.
COPY --chown=tracking:tracking src ./src
COPY --chown=tracking:tracking alembic ./alembic
COPY --chown=tracking:tracking alembic.ini pyproject.toml ./

USER tracking
EXPOSE 8000

# Container-side healthcheck, mirroring the compose one (compose's `healthcheck:`
# is what `depends_on: condition: service_healthy` reads; this one makes the image
# self-describing for a plain `docker run`). python -m urllib, NOT curl:
# python:3.12-slim ships neither curl nor wget (verified), and installing curl for
# a probe would add an apt layer to buy nothing — the interpreter is already here.
# The path is the service's own UNPREFIXED /v1/health; the gateway-prefixed
# /v1/tracking/health only exists after nginx rewrites (see health_router.py).
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/v1/health', timeout=2).status == 200 else 1)"]

# ── OpenTelemetry: the two settings the generated env file does NOT carry ────
# Everything else the SDK needs — OTEL_EXPORTER_OTLP_ENDPOINT, _PROTOCOL,
# OTEL_METRICS_EXPORTER=none, OTEL_LOGS_EXPORTER=none — already arrives via
# .env.local.tracking (Terraform-generated, never hand-edited). These two are
# absent there, so they are declared HERE, as image-level defaults.
#
# Still environment variables, NOT SDK-options-in-code: that is the whole point.
# [[logging-context]] forbids configuring the SDK programmatically because three
# silent failures in this repo came from it. An `ENV` is read by the same
# auto-configuration as any other env var and is OVERRIDDEN by compose's
# env_file if that file ever grows these keys — code would not be.
#
# OTEL_SERVICE_NAME: without it the resource falls back to
# `unknown_service:python` and the service shows up in Jaeger under that name
# instead of `tracking` — indistinguishable from any other unnamed Python
# process. Matches the `service_name` the JSON log formatter already emits.
ENV OTEL_SERVICE_NAME=tracking
# OTEL_PYTHON_FASTAPI_EXCLUDED_URLS drops the liveness probe from TRACING only
# (its LOG lines are a separate concern and deliberately untouched). GET
# /v1/health is ~72% of this service's request volume — the compose/Fargate probe
# hits it every 10s — and each hit would otherwise be a trace in Jaeger that
# describes nothing.
#
# The value is matched with `re.search` against the FULL RECONSTRUCTED URL —
# `http://127.0.0.1:8000/v1/health`, not `/v1/health`. That is not obvious and it
# is the difference between this working and silently doing nothing: the natural
# `^/v1/health$` compiles fine, matches nothing, and the exclusion just never
# fires (measured — health spans kept arriving in Jaeger). So there is no leading
# `^`. The trailing `$` is kept, so `/v1/healthcheck` or `/v1/health/deep` would
# still be traced rather than swallowed by a prefix match.
#
# Kept as its own ENV rather than a line continuation because a `\`-continued ENV
# cannot carry interleaved comments — the `#` line would be parsed as part of the
# value.
ENV OTEL_PYTHON_FASTAPI_EXCLUDED_URLS="/v1/health$"

# `src.main:app` — the module-level app built by create_app() (src/main.py), which
# is the command CLAUDE.md §2 documents. The factory exists for tests to build an
# app with overridden dependencies; the process runs the singleton, so this is a
# plain target and NOT --factory.
# No --reload here — that is a local-dev concern and compose adds it via `command:`
# for the docker-watch `sync` (see the header comment).
# Bound to 0.0.0.0: 127.0.0.1 would only be reachable from inside the container,
# so the published port and every in-network caller (nginx) would get connection
# refused.
#
# `opentelemetry-instrument` is the ZERO-CODE path: it loads every installed
# `opentelemetry_instrumentor` entry point (fastapi, sqlalchemy, grpc_client)
# and configures the SDK entirely from the OTEL_* environment before importing
# the app. Wrapping the command rather than calling `.instrument()` in Python is
# what keeps this service's tracing config out of the source tree — and it is
# also what guarantees the instrumentations patch fastapi/sqlalchemy/grpc BEFORE
# src.main imports them. Instrumenting after import silently produces no spans.
#
# NOTE for docker-watch: compose overrides `command:` for local dev. An override
# that runs bare `uvicorn --reload` bypasses this wrapper and the container
# emits no traces — the override must keep the `opentelemetry-instrument` prefix.
CMD ["opentelemetry-instrument", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
