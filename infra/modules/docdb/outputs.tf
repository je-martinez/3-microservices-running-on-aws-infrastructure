# Endpoint/port resolve from whichever implementation actually created the
# cluster — the native resource (prod) or the Floci fallback's JSON descriptor
# (manage_cluster_via_provider = false). Kept as locals rather than inlined in
# the outputs because aws_ssm_parameter in main.tf consumes them too, and the
# two must never disagree.
locals {
  cluster_via_cli = var.manage_cluster_via_provider ? null : jsondecode(data.local_file.cluster_via_cli[0].content)

  endpoint = var.manage_cluster_via_provider ? aws_docdb_cluster.this[0].endpoint : local.cluster_via_cli.Endpoint
  port     = var.manage_cluster_via_provider ? aws_docdb_cluster.this[0].port : local.cluster_via_cli.Port
}

output "cluster_identifier" {
  description = "DocumentDB cluster identifier — used to derive the Floci backing container name floci-docdb-<cluster_identifier> (see docs/lessons/floci-sqs-lambda-docdb-support.md)."
  # local.cluster_identifier, NOT the resource attribute: it is the same string
  # on both paths by construction, and reading it from the local keeps this
  # output resolvable when the native resource is gated off. The fallback script
  # is passed that very value and echoes it back in its descriptor, so the
  # container name derived from this output always matches the real container.
  value = local.cluster_identifier
}

output "endpoint" {
  description = "DocumentDB cluster endpoint (not host-reachable locally — see the lesson above; use the container name instead)."
  value       = local.endpoint
}

output "port" {
  description = "DocumentDB port."
  value       = local.port
}

output "master_username" {
  description = "DocumentDB master username."
  value       = var.master_username
}
