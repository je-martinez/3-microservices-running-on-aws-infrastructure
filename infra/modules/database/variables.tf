variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "master_username" {
  description = "Master username for the DocumentDB cluster."
  type        = string
  default     = "docdbadmin"
}

variable "master_password" {
  description = "Master password for the DocumentDB cluster. Must be provided; do not set a default."
  type        = string
  sensitive   = true
}

variable "subnet_ids" {
  description = "List of subnet IDs for the DB subnet group."
  type        = list(string)
}

variable "security_group_ids" {
  description = "List of security group IDs to attach to the cluster."
  type        = list(string)
}

variable "create_subnet_group" {
  description = "Create a managed DB subnet group. Default true for real AWS. Set false for Floci local (Floci's DocumentDB subnet group creation fails with InvalidClientTokenId), and pass subnet_group_name instead."
  type        = bool
  default     = true
}

variable "subnet_group_name" {
  description = "Name of a pre-existing DB subnet group to use when create_subnet_group = false (e.g. Floci's 'default')."
  type        = string
  default     = null
}

variable "instance_class" {
  description = "Instance class for the DocumentDB instance."
  type        = string
  default     = "db.t3.medium"
}

variable "engine_version" {
  description = "DocumentDB engine version. Floci's emulated cluster reports 5.0.0 regardless of what is requested (see docs/lessons/floci-sqs-lambda-docdb-support.md)."
  type        = string
  default     = "5.0.0"
}

variable "skip_final_snapshot" {
  description = "Whether to skip the final snapshot on cluster deletion."
  type        = bool
  default     = true
}

variable "manage_cluster_via_provider" {
  description = <<-EOT
    Create the DocumentDB cluster + instance with the native aws_docdb_cluster /
    aws_docdb_cluster_instance resources (true, default — REAL AWS), or with the
    awscli/boto3 fallback in scripts/create_docdb_cluster.py (false — FLOCI LOCAL
    ONLY).

    Set false only for Floci: the native resource aborts the apply with
    "creating DocumentDB Cluster (<id>): InvalidClientTokenId: The security token
    included in the request is invalid. status code: 403", while the identical
    CreateDBCluster call through the AWS CLI / boto3 succeeds against the same
    live Floci (verified 2026-08-03). Floci implements DocumentDB fine; the AWS
    provider pinned at `= 5.31.0` — pinned because newer versions break
    aws_cognito_user_pool_client against Floci — signs this particular request in
    a way Floci's docdb handler rejects. Same class of failure as
    create_subnet_group, one resource further in.

    When false, the cluster lives OUTSIDE Terraform's resource lifecycle:
    `terraform plan` cannot diff drift on it, and idempotency is the script's
    responsibility. See docs/shared/patterns/awscli-fallback-for-floci.md.
  EOT
  type        = bool
  default     = true
}

variable "aws_cli_endpoint_url" {
  description = "Endpoint override for the manage_cluster_via_provider = false fallback (e.g. http://localhost:4566 for Floci). Empty string (default) uses normal endpoint resolution (AWS_ENDPOINT_URL, profile config, or real AWS). Unused when manage_cluster_via_provider = true."
  type        = string
  default     = ""
}

variable "region" {
  description = "AWS region passed to the manage_cluster_via_provider = false fallback script. Unused when manage_cluster_via_provider = true."
  type        = string
  default     = "us-east-1"
}

variable "local_state_dir" {
  description = "Directory where the manage_cluster_via_provider = false fallback writes/reads the created cluster's JSON descriptor. Must be writable and stable across applies. Empty string (default) resolves to path.root/.terraform-docdb in main.tf (variable defaults cannot reference path.*). Unused when manage_cluster_via_provider = true."
  type        = string
  default     = ""
}

variable "python_bin" {
  description = <<-EOT
    Absolute path to the repo venv's Python interpreter, used by the
    manage_cluster_via_provider = false fallback's local-exec provisioner. Passed
    by the root module, which knows the repo root; this module is shared, so it
    cannot derive a reliable relative depth of its own. Never plain `python3` — a
    developer's shell may already be inside an unrelated venv, and an apply must
    not pick up a stray interpreter.

    Defaults to "" because the native path (prod) never runs a provisioner. A
    lifecycle.precondition on terraform_data.cluster_via_cli (main.tf) rejects an
    empty value when the fallback IS enabled, so a mis-wired root fails at plan
    time rather than at apply time with a confusing "command not found". It is a
    precondition rather than a variable `validation` block because the latter
    could not reference manage_cluster_via_provider below Terraform 1.9, and this
    repo's floor is >= 1.7.
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
    the cluster is managed by the native provider and the script does not run at
    all.
  EOT
  type        = string
  default     = ""
}
