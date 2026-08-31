# Tracking service — the Go port (gin + database/sql on Go 1.26).
#
# Build context: services/tracking-go (this directory) — NOT the repo root, the
# same choice its Python peer makes and for the same reason: this tree is
# self-contained. The Users gRPC stubs are COMMITTED under
# internal/adapter/grpcusers/gen/, so proto/users.proto is read neither at build
# time nor at run time and no protoc/buf is needed in any stage.
#
# Multi-stage, and the payoff is much larger than it is for the Python image: the
# `builder` stage carries the whole Go toolchain (~600 MB) and produces ONE
# statically linked binary, so the `runtime` stage can be a distroless base with
# no interpreter, no package manager, and no shell. Nothing that is not the
# binary and its CA bundle ships.
#
# There is deliberately NO docker-watch `develop:` counterpart in compose for
# this service: Go is COMPILED, so a synced source file changes nothing in a
# running container. Its Python peer can sync ./src because uvicorn --reload
# re-imports it; here a code change means `docker compose up -d --build
# tracking-go`, which is the honest cost of the runtime rather than a gap in the
# setup.

# ── builder stage: compile the server binary ─────────────────────────────────
# Pinned to the version in .go-version. Keep the two in step — a builder ahead of
# .go-version compiles code the local `make test` never ran through.
FROM golang:1.26.7-bookworm AS builder
WORKDIR /src

# Manifests FIRST, source second: a handler edit must not re-download the module
# graph. `go mod download` is its own layer for exactly that reason.
COPY go.mod go.sum ./
RUN go mod download

# Application source. internal/ and cmd/ only — migrations/ are applied by the
# golang-migrate CLI from a developer machine or a task, never by this process
# (see migrations/README.md), so shipping them would be dead weight that also
# implies the binary might run them.
COPY cmd ./cmd
COPY internal ./internal

# CGO_ENABLED=0 is load-bearing, not a habit: the runtime stage below is
# distroless/static, which carries no libc. A cgo-linked binary builds fine here
# and then dies at exec with "no such file or directory" — a message that names
# the binary rather than the missing loader, and reads as a broken COPY.
#
# -trimpath strips local build paths out of the binary; -ldflags="-s -w" drops
# the symbol table and DWARF, which is a few MB of an image that will never be
# debugged with gdb.
ENV CGO_ENABLED=0 GOOS=linux
RUN go build -trimpath -ldflags="-s -w" -o /out/tracking-server ./cmd/server

# ── runtime stage: the binary, nothing else ──────────────────────────────────
# distroless/static-debian12: CA certificates, /etc/passwd, tzdata — and no
# shell. `:nonroot` runs as uid 65532 without needing a useradd, so there is no
# RUN in this stage at all.
#
# The absence of a shell is a real constraint to know before debugging: there is
# no `docker exec ... sh` into this container. Read the logs, or exec into the
# Python peer, which shares the same network and env file.
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

COPY --from=builder /out/tracking-server /app/tracking-server

EXPOSE 8000

# ── OpenTelemetry: the settings the generated env file does NOT carry ────────
# Everything else the SDK needs — OTEL_EXPORTER_OTLP_ENDPOINT, _PROTOCOL,
# OTEL_METRICS_EXPORTER=none, OTEL_LOGS_EXPORTER=none — already arrives via
# .env.local.tracking (Terraform-generated, never hand-edited). This one is
# absent there, so it is declared HERE as an image-level default.
#
# Still an environment variable, NOT an SDK option in code: [[logging-context]]
# forbids configuring the SDK programmatically because three silent failures in
# this repo came from it. An ENV is read by the same auto-configuration as any
# other env var, and compose's env_file OVERRIDES it if that file ever grows the
# key — code would not be.
#
# The value is `tracking`, NOT `tracking-go`, and that is the whole point of the
# migration: one query in OpenObserve must select this service's spans whichever
# runtime is serving them. A distinct name would silently split every existing
# dashboard and saved search in two at the cutover.
ENV OTEL_SERVICE_NAME=tracking

# No HEALTHCHECK instruction: distroless ships neither curl, wget, nor a shell,
# so there is no in-image probe to run. The compose healthcheck for this service
# is defined host-side in docker-compose.yml — read the comment there, it
# explains the mechanism it uses instead.

USER nonroot:nonroot

# ENTRYPOINT (exec form), not CMD: with no shell in the image there is nothing to
# interpolate, and an entrypoint means `docker run tracking-go --flag` appends
# rather than replacing the binary. The port comes from PORT in the env file, not
# from a flag.
ENTRYPOINT ["/app/tracking-server"]
