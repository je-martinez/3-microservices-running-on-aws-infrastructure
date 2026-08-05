# ─── Local naming ───────────────────────────────────────────────────────────────
# Both implementations (native resources and the Floci fallback) derive their
# identifiers from these, so the two paths CANNOT drift. The cluster identifier
# in particular is a hard contract: Floci names the backing mongo container
# `floci-docdb-<cluster_identifier>`, and that container name is the only way
# anything on 3mrai-network reaches Mongo (27017 is not published to the host,
# and the reported IP changes on every recreation). See
# docs/lessons/floci-sqs-lambda-docdb-support.md.
locals {
  cluster_identifier  = "${var.context.id}-docdb"
  instance_identifier = "${var.context.id}-docdb-instance"

  # Where the fallback writes / reads the created cluster's JSON descriptor.
  # path.root (the ROOT module's working directory), never path.module — module
  # source may be shared and read-only. Same shape as modules/cognito.
  state_file = "${var.local_state_dir != "" ? var.local_state_dir : "${path.root}/.terraform-docdb"}/${local.cluster_identifier}.json"
}

# ─── DocumentDB Subnet Group ────────────────────────────────────────────────────
# Optional: Floci's DocumentDB subnet-group creation fails outright with
# "InvalidClientTokenId: The security token included in the request is
# invalid" (verified 2026-08-03, `make bootstrap`) — unlike rds-aurora's
# quirk, this isn't a tag-read side effect, the create call itself never
# succeeds. Local Floci sets create_subnet_group = false and points the
# cluster at Floci's pre-existing "default" subnet group instead (see
# subnet_group_name below), mirroring the rds-aurora module's toggle.
resource "aws_docdb_subnet_group" "this" {
  count = var.create_subnet_group ? 1 : 0

  name       = "${var.context.id}-docdb-subnet-group"
  subnet_ids = var.subnet_ids

  tags = merge(var.context.tags, { Name = "${var.context.id}-docdb-subnet-group" })
}

# ─── DocumentDB Cluster ──────────────────────────────────────────────────────────
# THE PRODUCTION PATH. Kept exactly as it was — real AWS needs it, and nothing
# below replaces it there.
#
# var.manage_cluster_via_provider gates which implementation creates the cluster:
# - true (default, prod): these native resources.
# - false (Floci local only): the awscli fallback further down. The native
#   resource ABORTS the apply against Floci with
#   "creating DocumentDB Cluster (db-3mrai-local-events-docdb):
#    InvalidClientTokenId: The security token included in the request is invalid.
#    status code: 403", while the identical CreateDBCluster call through the
#   AWS CLI / boto3 succeeds against the same live Floci — so Floci implements
#   DocumentDB fine and it is the pinned provider (`= 5.31.0`, pinned because
#   newer versions break aws_cognito_user_pool_client) that signs the request in
#   a way Floci's docdb handler rejects. Same class of failure the subnet group
#   already hit one resource earlier; see var.create_subnet_group above.
resource "aws_docdb_cluster" "this" {
  count = var.manage_cluster_via_provider ? 1 : 0

  cluster_identifier     = local.cluster_identifier
  engine                 = "docdb"
  engine_version         = var.engine_version
  master_username        = var.master_username
  master_password        = var.master_password
  db_subnet_group_name   = var.create_subnet_group ? aws_docdb_subnet_group.this[0].name : var.subnet_group_name
  vpc_security_group_ids = var.security_group_ids
  skip_final_snapshot    = var.skip_final_snapshot

  tags = merge(var.context.tags, { Name = local.cluster_identifier })
}

# ─── DocumentDB Instance ─────────────────────────────────────────────────────────
# Floci backs this with a single standalone mongo:7.0 container (no replica set —
# see docs/lessons/floci-sqs-lambda-docdb-support.md, Finding 1: no multi-document
# transactions locally). Real AWS scales this to multiple instances; local stays
# at one, matching what Floci actually emulates.
resource "aws_docdb_cluster_instance" "this" {
  count = var.manage_cluster_via_provider ? 1 : 0

  identifier         = local.instance_identifier
  cluster_identifier = aws_docdb_cluster.this[0].id
  instance_class     = var.instance_class
  engine             = "docdb"

  tags = merge(var.context.tags, { Name = local.instance_identifier })
}

# ─── DocumentDB Cluster — Floci fallback (bypasses the aws provider) ─────────────
# Only created when var.manage_cluster_via_provider = false. Creates the cluster
# and its instance with a plain boto3 call, outside Terraform's resource
# lifecycle, so the provider's request signing never enters the picture. The
# script is idempotent (lookup-then-create, and treats *AlreadyExistsFault as
# success) because `make bootstrap` rebuilds this stack routinely and
# terraform_data re-runs the provisioner whenever `input` changes. The resulting
# endpoint/port are written to a JSON descriptor under the root module's working
# directory that `data.local_file.cluster_via_cli` reads back into the outputs.
# See scripts/create_docdb_cluster.py and
# docs/shared/patterns/awscli-fallback-for-floci.md.
resource "terraform_data" "cluster_via_cli" {
  count = var.manage_cluster_via_provider ? 0 : 1

  # Everything the script would need to re-run for: a changed identifier,
  # credentials, engine version, instance class, or placement. terraform_data
  # replaces when `input` changes, so any of these re-runs the provisioner —
  # and the subnet-group entry additionally makes this resource DEPEND on
  # aws_docdb_subnet_group when that one is managed here.
  input = {
    cluster_identifier  = local.cluster_identifier
    instance_identifier = local.instance_identifier
    master_username     = var.master_username
    engine_version      = var.engine_version
    instance_class      = var.instance_class
    subnet_group_name   = var.create_subnet_group ? aws_docdb_subnet_group.this[0].name : coalesce(var.subnet_group_name, "")
    security_group_ids  = join(",", var.security_group_ids)
    state_file          = local.state_file
  }

  provisioner "local-exec" {
    command     = "${var.python_bin} ${path.module}/scripts/create_docdb_cluster.py"
    interpreter = ["/usr/bin/env", "bash", "-c"]
    environment = {
      CLUSTER_IDENTIFIER  = self.input.cluster_identifier
      INSTANCE_IDENTIFIER = self.input.instance_identifier
      MASTER_USERNAME     = self.input.master_username
      # Not in `input`: terraform_data.input lands in state in plaintext, and a
      # rotated password must not be the thing that decides whether the cluster
      # is recreated either. The script only ever uses it on the create path.
      MASTER_PASSWORD    = var.master_password
      ENGINE_VERSION     = self.input.engine_version
      INSTANCE_CLASS     = self.input.instance_class
      SUBNET_GROUP_NAME  = self.input.subnet_group_name
      SECURITY_GROUP_IDS = self.input.security_group_ids
      STATE_FILE         = self.input.state_file
      ENDPOINT_URL       = var.aws_cli_endpoint_url
      AWS_REGION         = var.region
      # Traceability only — the script always runs, whatever this records. Empty
      # (the variable's default) means "record nothing", which the script treats
      # as a legitimate state rather than an error.
      EXECUTION_LOG_TABLE = var.execution_log_table
    }
  }

  lifecycle {
    precondition {
      condition     = var.python_bin != ""
      error_message = "manage_cluster_via_provider = false requires python_bin (absolute path to the repo venv interpreter); a root module that forgets it would otherwise fail mid-apply with 'command not found'."
    }
  }
}

data "local_file" "cluster_via_cli" {
  count      = var.manage_cluster_via_provider ? 0 : 1
  filename   = terraform_data.cluster_via_cli[0].input.state_file
  depends_on = [terraform_data.cluster_via_cli]
}

# ─── No Parameter Store entries ───────────────────────────────────────────────────
# This module deliberately publishes NOTHING to Parameter Store. It briefly did,
# citing ADR-0007, and both `aws_ssm_parameter` resources failed against Floci
# with `UnrecognizedClientException: The security token included in the request
# is invalid` — the same provider-signing failure that already forced the
# awscli-fallback for the cluster itself (the CLI/boto3 call succeeds against the
# same live Floci).
#
# They were removed rather than gated or faked, because nothing read them. This
# repo has no other `aws_ssm_parameter` anywhere — a fact its own env generator
# records (`scripts/generate_env_files.py`: "as of today this repo has ZERO
# aws_ssm_parameter resources") — and every consumer takes host/port from
# `terraform output` instead. ADR-0007 states the intent for production secrets;
# it does not describe what is wired today. Keeping two parameters that only ever
# fail, for readers that do not exist, is cost with no benefit.
#
# If production ever needs them, add them behind the same kind of gate the
# cluster uses (`manage_cluster_via_provider`), so the local path stays clear of
# the provider bug.
