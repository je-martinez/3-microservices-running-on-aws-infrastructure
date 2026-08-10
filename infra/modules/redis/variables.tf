# Matches every other module in this repo: modules do NOT instantiate the
# `label` module themselves — they receive an already-resolved context object
# exposing `.id` and `.tags`, and derive names as "${var.context.id}-<suffix>".
# See infra/modules/docdb/variables.tf for the same declaration.
variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "description" {
  description = "Human-readable description of the replication group (required by the ElastiCache API)."
  type        = string
  default     = "Redis replication group"
}

variable "engine" {
  description = <<-EOT
    Cache engine. "redis" or "valkey".

    NOTE this module deliberately creates an aws_elasticache_replication_group
    and NOT an aws_elasticache_cluster. Redis/Valkey must be created through
    CreateReplicationGroup — Floci rejects CreateCacheCluster with
    "Engine must be 'memcached'. For Redis/Valkey use CreateReplicationGroup.",
    and real AWS deprecated standalone Redis cache clusters in the same
    direction. aws_elasticache_cluster is memcached-only for our purposes.
  EOT
  type        = string
  default     = "redis"

  validation {
    condition     = contains(["redis", "valkey"], var.engine)
    error_message = "engine must be \"redis\" or \"valkey\" — this module creates a replication group, which does not serve memcached."
  }
}

variable "engine_version" {
  description = "Cache engine version. Floci backs the group with a valkey/valkey:8 container regardless of what is requested."
  type        = string
  default     = "7.1"
}

variable "node_type" {
  description = "ElastiCache node type. Ignored by Floci (it runs a plain container), sized for real AWS."
  type        = string
  default     = "cache.t4g.micro"
}

variable "num_cache_clusters" {
  description = "Number of cache nodes in the replication group (1 = primary only, no replica). Locally Floci runs a single container regardless."
  type        = number
  default     = 1
}

variable "port" {
  description = "Port the cache listens on. 6379 is both the Redis default and the port Floci's backing container publishes on the Docker network."
  type        = number
  default     = 6379
}

variable "subnet_ids" {
  description = "Subnet IDs for the cache subnet group. Unused when create_subnet_group = false."
  type        = list(string)
  default     = []
}

variable "security_group_ids" {
  description = "VPC security group IDs to attach to the replication group."
  type        = list(string)
  default     = []
}

variable "create_subnet_group" {
  description = <<-EOT
    Create a managed ElastiCache subnet group (aws_elasticache_subnet_group).
    Default true for real AWS.

    Set FALSE for Floci: it does not implement the subnet-group API at all —
    both CreateCacheSubnetGroup and DescribeCacheSubnetGroups answer
    "UnsupportedOperation: Operation ... is not supported" (verified 2026-08-09).
    Unlike rds-aurora/docdb, there is no pre-existing "default" group to fall
    back to either, so subnet_group_name is left null locally and the
    replication group is created without one. Floci does not need it: the
    backing container is attached to the compose network directly.
  EOT
  type        = bool
  default     = true
}

variable "at_rest_encryption_enabled" {
  description = "Encrypt data at rest. Real AWS only; Floci ignores it (its container stores nothing encrypted)."
  type        = bool
  default     = true
}

variable "transit_encryption_enabled" {
  description = <<-EOT
    Encrypt data in transit (TLS). Default FALSE, and that default is for real
    AWS as much as for local: enabling it changes the client contract (the
    service must dial rediss:// and present a TLS-capable client), so it is an
    opt-in per environment rather than a silent default. Floci terminates no
    TLS, exactly like its RDS/MySQL proxy.
  EOT
  type        = bool
  default     = false
}

variable "manage_via_provider" {
  description = <<-EOT
    Create the replication group with the native aws_elasticache_replication_group
    resource (true, default — REAL AWS), or with the boto3 fallback in
    scripts/create_replication_group.py (false — FLOCI LOCAL ONLY).

    Set false only for Floci. The native resource does not merely fail there, it
    CRASHES the provider (verified 2026-08-09, provider pinned = 5.31.0):

        panic: runtime error: index out of range [0] with length 0
        .../internal/service/elasticache/replication_group.go:632
        .../internal/service/elasticache/replication_group.go:575
        Error: The terraform-provider-aws_v5.31.0_x5 plugin crashed!

    Root cause: after CreateReplicationGroup the provider reads NodeGroups[0]
    off the response to populate primary_endpoint_address/reader_endpoint_address.
    Floci returns a replication group with NO NodeGroups array at all (it reports
    only ConfigurationEndpoint), so the provider indexes an empty slice.

    That failure is unfixable from configuration — no combination of arguments
    makes Floci emit NodeGroups — and it is WORSE than an ordinary error: the
    group IS created in Floci before the panic, but the crash means nothing lands
    in Terraform state, so the next apply fails with
    ReplicationGroupAlreadyExistsFault and the root is wedged. The identical
    CreateReplicationGroup call through boto3/AWS CLI succeeds cleanly and
    returns Status "available".

    That is exactly the criterion in docs/shared/patterns/awscli-fallback-for-floci.md:
    the native resource demonstrably cannot apply (proven by a real crash, not
    speculation), the SDK call demonstrably can. Production keeps the native
    resource.

    When false, the group lives OUTSIDE Terraform's resource lifecycle:
    `terraform plan` cannot diff drift on it, and idempotency is the script's
    responsibility.
  EOT
  type        = bool
  default     = true
}

variable "aws_cli_endpoint_url" {
  description = "Endpoint override for the manage_via_provider = false fallback (e.g. http://localhost:4566 for Floci). Empty string (default) uses normal endpoint resolution. Unused when manage_via_provider = true."
  type        = string
  default     = ""
}

variable "region" {
  description = "AWS region passed to the manage_via_provider = false fallback script. Unused when manage_via_provider = true."
  type        = string
  default     = "us-east-1"
}

variable "local_state_dir" {
  description = "Directory where the manage_via_provider = false fallback writes/reads the created group's JSON descriptor. Empty string (default) resolves to path.root/.terraform-redis in main.tf (variable defaults cannot reference path.*). Unused when manage_via_provider = true."
  type        = string
  default     = ""
}

variable "python_bin" {
  description = <<-EOT
    Absolute path to the repo venv's Python interpreter, used by the
    manage_via_provider = false fallback's local-exec provisioner. Passed by the
    root module, which knows the repo root; this module is shared, so it cannot
    derive a reliable relative depth of its own. Never plain `python3` — a
    developer's shell may already be inside an unrelated venv.

    Defaults to "" because the native path (prod) never runs a provisioner. A
    lifecycle.precondition on terraform_data.group_via_cli (main.tf) rejects an
    empty value when the fallback IS enabled, so a mis-wired root fails at plan
    time rather than mid-apply with "command not found". Same shape as
    modules/docdb.
  EOT
  type        = string
  default     = ""
}

variable "execution_log_table" {
  description = <<-EOT
    DynamoDB table where the fallback's local-exec script records each run, for
    TRACEABILITY ONLY — the log never causes a run to be skipped (see
    infra/scripts/lib3mrai/execution_log.py).

    Empty string (default) disables recording, which is what prod wants: there
    the group is managed by the native provider and the script never runs.
  EOT
  type        = string
  default     = ""
}
