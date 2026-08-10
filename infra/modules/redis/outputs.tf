# Endpoint/port resolve from whichever implementation actually created the group
# — the native resource (prod) or the Floci fallback's JSON descriptor
# (manage_via_provider = false). Kept as locals rather than inlined so the two
# paths can never disagree.
locals {
  group_via_cli = var.manage_via_provider ? null : jsondecode(data.local_file.group_via_cli[0].content)

  # Real AWS: the primary endpoint is what a non-cluster-mode client dials.
  # Floci: the descriptor carries ConfigurationEndpoint.Address, which is
  # literally the string "localhost" — see the redis_host output below for why
  # that value must NEVER reach a service.
  endpoint = var.manage_via_provider ? aws_elasticache_replication_group.this[0].primary_endpoint_address : local.group_via_cli.Address
  port     = var.manage_via_provider ? aws_elasticache_replication_group.this[0].port : local.group_via_cli.Port
}

output "replication_group_id" {
  description = "ElastiCache replication group id — derives the Floci backing container name floci-valkey-<id>."
  # local.replication_group_id, NOT the resource attribute: it is the same string
  # on both paths by construction, and reading it from the local keeps this
  # output resolvable when the native resource is gated off. The fallback script
  # is passed that very value and echoes it back in its descriptor, so the
  # container name derived from this output always matches the real container.
  value = local.replication_group_id
}

# ─── THE HOST A SERVICE ACTUALLY CONNECTS TO ────────────────────────────────────
# READ THIS BEFORE "FIXING" THE VALUE BELOW.
#
# Locally this is the BACKING CONTAINER NAME, not the endpoint ElastiCache
# reports. Floci returns ConfigurationEndpoint.Address = "localhost" (verified
# 2026-08-09), which is useless — and actively misleading — to a service running
# inside the Docker network: `localhost` there is the service's own container, so
# a connection attempt fails with ECONNREFUSED rather than anything that points
# at the real problem.
#
# Floci backs the replication group with a REAL container named
# `floci-valkey-<replication_group_id>` (image valkey/valkey:8), attached to
# 3mrai_3mrai-network with NO host port published. Docker DNS resolves that name
# on the network, so it is the ONLY way in. This is the same shape as the
# DocumentDB quirk (floci-docdb-<cluster-id>) documented in
# functions/events-pipeline/CLAUDE.md §3b and modules/docdb.
#
# Unlike Floci's RDS proxy ports — which are assigned by cluster creation order
# and must be DISCOVERED per engine at runtime — this hostname is DETERMINISTIC:
# the replication group id is chosen by us in Terraform, so the container name is
# known at plan time and needs no discovery script.
#
# In production the container name has no meaning and this resolves to the real
# ElastiCache primary endpoint instead, so consumers read ONE variable either way.
output "redis_host" {
  description = "Host a service connects to. LOCAL: the floci-valkey-<id> container name over Docker DNS (never 'localhost' — see the comment in outputs.tf). PROD: the ElastiCache primary endpoint."
  value       = var.manage_via_provider ? local.endpoint : "floci-valkey-${local.replication_group_id}"
}

# ─── THE PORT A SERVICE ACTUALLY CONNECTS TO ────────────────────────────────────
# READ THIS BEFORE "FIXING" THE VALUE BELOW — it is deliberately NOT local.port.
#
# Same trap as redis_host above, and it stayed hidden while the two happened to
# agree. Floci's ConfigurationEndpoint reports the HOST-SIDE PROXY port, taken
# from FLOCI_SERVICES_ELASTICACHE_PROXY_BASE_PORT/_MAX_PORT in docker-compose.yml
# (this repo moved that range OFF the 6379-6399 default so a developer's own local
# Redis can coexist). The BACKING CONTAINER, meanwhile, always listens on plain
# 6379 inside the Docker network.
#
# So the API's port and the container's port are different numbers locally, and a
# service on 3mrai-network must use the CONTAINER's. Verified from inside
# 3mrai-users-1 while the proxy range was 6479-6499: `nc -z <container> 6379`
# succeeded, `nc -z <container> 6479` did not answer at all.
#
# `var.port` is that container port (6379), the same value handed to the fallback
# script when it creates the group — so this cannot drift from what Floci launched.
# In production there is no proxy and no container name: the native resource's port
# IS the port a client dials, so the provider path keeps reading local.port.
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
