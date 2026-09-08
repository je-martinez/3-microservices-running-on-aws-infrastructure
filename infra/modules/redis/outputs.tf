# CONTRACT: Kept as locals, not inlined, so the native path (prod) and the Floci
# fallback's JSON descriptor can never disagree on endpoint/port.
locals {
  group_via_cli = var.manage_via_provider ? null : jsondecode(data.local_file.group_via_cli[0].content)

  # WARNING: Locally this resolves to the literal string "localhost" — see the
  # redis_host output below for why that value must NEVER reach a service.
  endpoint = var.manage_via_provider ? aws_elasticache_replication_group.this[0].primary_endpoint_address : local.group_via_cli.Address
  port     = var.manage_via_provider ? aws_elasticache_replication_group.this[0].port : local.group_via_cli.Port
}

output "replication_group_id" {
  description = "ElastiCache replication group id — derives the Floci backing container name floci-valkey-<id>."
  # CONTRACT: Read the local, NOT the resource attribute — the native resource is
  # gated off locally, and the local is what the fallback script is handed, so the
  # derived container name always matches the real container.
  value = local.replication_group_id
}

# ─── THE HOST A SERVICE ACTUALLY CONNECTS TO ────────────────────────────────────
# WORKAROUND(local): Do NOT "fix" this to the reported endpoint. Floci returns
# ConfigurationEndpoint.Address = "localhost", which inside the Docker network is
# the caller's OWN container — the connection fails with ECONNREFUSED, pointing
# nowhere near the real problem. The backing container
# `floci-valkey-<replication_group_id>` publishes no host port, so Docker DNS on
# that name is the only way in. Unlike the RDS proxy ports, this name is
# deterministic (we choose the group id), so it needs no discovery script.
# Production resolves to the real primary endpoint, so consumers read one
# variable either way.
# See [[floci-elasticache-two-ports-and-provider-panic]]
output "redis_host" {
  description = "Host a service connects to. LOCAL: the floci-valkey-<id> container name over Docker DNS (never 'localhost' — see the comment in outputs.tf). PROD: the ElastiCache primary endpoint."
  value       = var.manage_via_provider ? local.endpoint : "floci-valkey-${local.replication_group_id}"
}

# ─── THE PORT A SERVICE ACTUALLY CONNECTS TO ────────────────────────────────────
# WORKAROUND(local): Do NOT "fix" this to local.port. Floci's
# ConfigurationEndpoint reports the HOST-SIDE PROXY port (from the
# FLOCI_SERVICES_ELASTICACHE_PROXY_* range, which this repo moved off the 6379
# default so a developer's own Redis can coexist), while the backing container
# listens on plain 6379 inside the network. A service on 3mrai-network dialling
# the proxy port gets no answer at all. `var.port` is that container port, the
# same value handed to the fallback script, so it cannot drift from what Floci
# launched. Production has no proxy, so that path keeps reading local.port.
# See [[floci-elasticache-two-ports-and-provider-panic]]
output "redis_port" {
  description = "Port a service connects to. LOCAL: the backing container's own port (6379), NOT the host-side proxy port ElastiCache reports — those differ whenever the proxy range is moved off its default. PROD: the ElastiCache port."
  value       = var.manage_via_provider ? local.port : var.port
}

output "redis_proxy_port" {
  description = "Host-side proxy port Floci publishes for this group (local only; from the FLOCI_SERVICES_ELASTICACHE_PROXY_* range). For redis-cli/GUI sessions from the HOST — never for a service inside the Docker network. Equals redis_port in production."
  value       = local.port
}

output "endpoint" {
  description = "Raw endpoint as reported by the ElastiCache API. LOCAL: literally 'localhost' and NOT connectable from inside the Docker network — use redis_host instead. Exposed for debugging/parity only."
  value       = local.endpoint
}
