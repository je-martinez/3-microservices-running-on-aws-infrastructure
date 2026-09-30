# Tracking service — the Go port (gin + database/sql on Go 1.26).
#
# CONTRACT: Build context is services/tracking-go, NOT the repo root. The Users
# gRPC stubs are COMMITTED under internal/adapter/grpcusers/gen/, so no stage
# reads proto/users.proto and none needs protoc or buf.
#
# Compose carries no docker-watch `develop:` block for this service: Go is
# compiled, so a code change means `docker compose up -d --build tracking-go`.
# See [[2026-09-30-distroless-makes-cgo-a-build-time-contract]]

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

# CONTRACT: Keep CGO_ENABLED=0. The distroless runtime stage carries no libc,
# and a cgo-linked binary BUILDS here then dies at exec with "no such file or
# directory" — naming the binary, not the missing loader, so it reads as a
# broken COPY. -trimpath and -ldflags="-s -w" drop build paths and DWARF.
# See [[2026-09-30-distroless-makes-cgo-a-build-time-contract]]
ENV CGO_ENABLED=0 GOOS=linux
RUN go build -trimpath -ldflags="-s -w" -o /out/tracking-server ./cmd/server

# ── runtime stage: the binary, nothing else ──────────────────────────────────
# distroless/static-debian12: CA certificates, /etc/passwd, tzdata — and no
# shell, so `:nonroot` needs no useradd and this stage has no RUN at all.
# WARNING: No shell means no `docker exec ... sh` here. Read the logs, or exec
# into a peer container sharing the network. See [[2026-09-30-distroless-makes-cgo-a-build-time-contract]]
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

COPY --from=builder /out/tracking-server /app/tracking-server

EXPOSE 8000

# ── OpenTelemetry: the one setting the generated env file does NOT carry ─────
# CONTRACT: The value is `tracking`, never `tracking-go`. One OpenObserve query
# must select this service's spans whichever runtime serves them; a distinct
# name splits every dashboard and saved search in two.
#
# An ENV, not an SDK option in code: env_file OVERRIDES it should
# .env.local.tracking ever grow the key, and code would not.
# See [[logging-context]]
ENV OTEL_SERVICE_NAME=tracking

# No HEALTHCHECK: distroless ships neither curl, wget, nor a shell, so no
# in-image probe can run. It is defined host-side in docker-compose.yml.

USER nonroot:nonroot

# ENTRYPOINT (exec form), not CMD: no shell means nothing to interpolate, and an
# entrypoint makes `docker run tracking-go --flag` append rather than replace.
# The port comes from PORT in the env file, not a flag.
ENTRYPOINT ["/app/tracking-server"]
