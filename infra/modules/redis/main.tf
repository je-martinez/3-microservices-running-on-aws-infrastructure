# ─── Local naming ───────────────────────────────────────────────────────────────
# Both implementations (the native resource and the Floci fallback) derive their
# identifiers from these, so the two paths CANNOT drift. The replication group id
# in particular is a HARD CONTRACT: Floci names the backing container
# `floci-valkey-<replication_group_id>`, and that container name is the only way
# anything on 3mrai-network reaches Redis. See the redis_host output below.
locals {
  replication_group_id = "${var.context.id}-redis"
  subnet_group_name    = "${var.context.id}-redis-subnet-group"

  # Where the fallback writes / reads the created group's JSON descriptor.
  # path.root (the ROOT module's working directory), never path.module — module
  # source may be shared and read-only. Same shape as modules/docdb.
  state_file = "${var.local_state_dir != "" ? var.local_state_dir : "${path.root}/.terraform-redis"}/${local.replication_group_id}.json"
}

# ─── ElastiCache Subnet Group ───────────────────────────────────────────────────
# Optional, and OFF locally: Floci does not implement this API surface at all.
# Both calls answer UnsupportedOperation (verified 2026-08-09):
#
#   aws elasticache create-cache-subnet-group   -> UnsupportedOperation
#   aws elasticache describe-cache-subnet-groups -> UnsupportedOperation
#
# Note the difference from rds-aurora/docdb, which set create_subnet_group =
# false and then point at Floci's pre-existing "default" group: here there is no
# group to point at, because Floci cannot even list them. So locally the
# replication group is created with NO subnet group, which it does not need —
# Floci attaches the backing container to the compose network directly.
resource "aws_elasticache_subnet_group" "this" {
  count = var.create_subnet_group ? 1 : 0

  name       = local.subnet_group_name
  subnet_ids = var.subnet_ids

  tags = merge(var.context.tags, { Name = local.subnet_group_name })
}

# ─── Redis Replication Group ────────────────────────────────────────────────────
# THE PRODUCTION PATH. A REPLICATION GROUP, not aws_elasticache_cluster: Redis
# and Valkey must be created via CreateReplicationGroup. Floci rejects the
# cluster API outright — "Engine must be 'memcached'. For Redis/Valkey use
# CreateReplicationGroup." — and real AWS points the same way.
#
# var.manage_via_provider gates which implementation creates the group:
# - true (default, prod): this native resource.
# - false (Floci local only): the boto3 fallback further down, because this
#   resource CRASHES the provider against Floci (nil NodeGroups → index out of
#   range). Full evidence in var.manage_via_provider's description.
resource "aws_elasticache_replication_group" "this" {
  count = var.manage_via_provider ? 1 : 0

  replication_group_id = local.replication_group_id
  description          = var.description

  engine         = var.engine
  engine_version = var.engine_version
  node_type      = var.node_type
  port           = var.port

  # A single node: this cache holds password-reset codes with a 10-minute TTL —
  # regenerable state, not a system of record. Losing it costs a user one
  # "resend code" click, so a replica buys availability the data does not
  # warrant. Raise this (and automatic_failover_enabled with it) if the cache
  # ever holds something whose loss is not self-healing.
  num_cache_clusters = var.num_cache_clusters

  subnet_group_name  = var.create_subnet_group ? aws_elasticache_subnet_group.this[0].name : null
  security_group_ids = var.security_group_ids

  at_rest_encryption_enabled = var.at_rest_encryption_enabled
  transit_encryption_enabled = var.transit_encryption_enabled

  tags = merge(var.context.tags, { Name = local.replication_group_id })
}

# ─── Redis Replication Group — Floci fallback (bypasses the aws provider) ───────
# Only created when var.manage_via_provider = false. Creates the group with a
# plain boto3 call, outside Terraform's resource lifecycle, so the provider's
# post-create NodeGroups[0] read — the thing that panics — never happens. The
# script is idempotent (lookup-then-create, and treats ReplicationGroupAlreadyExists
# as success) because `make bootstrap` rebuilds this stack routinely and
# terraform_data re-runs the provisioner whenever `input` changes. The resulting
# endpoint/port are written to a JSON descriptor under the root module's working
# directory that `data.local_file.group_via_cli` reads back into the outputs.
# See scripts/create_replication_group.py and
# docs/shared/patterns/awscli-fallback-for-floci.md.
resource "terraform_data" "group_via_cli" {
  count = var.manage_via_provider ? 0 : 1

  # Everything the script would need to re-run for. terraform_data replaces when
  # `input` changes, so any of these re-runs the provisioner — and the
  # subnet-group entry additionally makes this resource DEPEND on
  # aws_elasticache_subnet_group when that one is managed here.
  input = {
    replication_group_id = local.replication_group_id
    description          = var.description
    engine               = var.engine
    engine_version       = var.engine_version
    node_type            = var.node_type
    num_cache_clusters   = var.num_cache_clusters
    port                 = var.port
    subnet_group_name    = var.create_subnet_group ? aws_elasticache_subnet_group.this[0].name : ""
    security_group_ids   = join(",", var.security_group_ids)
    state_file           = local.state_file
  }

  provisioner "local-exec" {
    command     = "${var.python_bin} ${path.module}/scripts/create_replication_group.py"
    interpreter = ["/usr/bin/env", "bash", "-c"]
    environment = {
      REPLICATION_GROUP_ID = self.input.replication_group_id
      DESCRIPTION          = self.input.description
      ENGINE               = self.input.engine
      ENGINE_VERSION       = self.input.engine_version
      NODE_TYPE            = self.input.node_type
      NUM_CACHE_CLUSTERS   = tostring(self.input.num_cache_clusters)
      PORT                 = tostring(self.input.port)
      SUBNET_GROUP_NAME    = self.input.subnet_group_name
      SECURITY_GROUP_IDS   = self.input.security_group_ids
      STATE_FILE           = self.input.state_file
      ENDPOINT_URL         = var.aws_cli_endpoint_url
      AWS_REGION           = var.region
      # Traceability only — the script always runs, whatever this records. Empty
      # (the variable's default) means "record nothing", which the script treats
      # as a legitimate state rather than an error.
      EXECUTION_LOG_TABLE = var.execution_log_table
    }
  }

  lifecycle {
    precondition {
      condition     = var.python_bin != ""
      error_message = "manage_via_provider = false requires python_bin (absolute path to the repo venv interpreter); a root module that forgets it would otherwise fail mid-apply with 'command not found'."
    }
  }
}

data "local_file" "group_via_cli" {
  count      = var.manage_via_provider ? 0 : 1
  filename   = terraform_data.group_via_cli[0].input.state_file
  depends_on = [terraform_data.group_via_cli]
}
