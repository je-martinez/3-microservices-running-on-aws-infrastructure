# ─── Local naming ───────────────────────────────────────────────────────────────
# CONTRACT: Both paths (native resources and the Floci fallback) derive their
# identifiers here so they cannot drift. Floci names the backing container
# `floci-docdb-<cluster_identifier>`, and that name is the only route to Mongo on
# 3mrai-network — 27017 is not published and the reported IP changes on every
# recreation. See [[floci-sqs-lambda-docdb-support]]
locals {
  cluster_identifier  = "${var.context.id}-docdb"
  instance_identifier = "${var.context.id}-docdb-instance"

  # CONTRACT: path.root, never path.module — module source may be read-only.
  state_file = "${var.local_state_dir != "" ? var.local_state_dir : "${path.root}/.terraform-docdb"}/${local.cluster_identifier}.json"
}

# ─── DocumentDB Subnet Group ────────────────────────────────────────────────────
# WORKAROUND(local): Do NOT create a subnet group against Floci — the create call
# itself fails with "InvalidClientTokenId". Local sets create_subnet_group =
# false and points the cluster at Floci's pre-existing "default" group.
# See [[awscli-fallback-for-floci]]
resource "aws_docdb_subnet_group" "this" {
  count = var.create_subnet_group ? 1 : 0

  name       = "${var.context.id}-docdb-subnet-group"
  subnet_ids = var.subnet_ids

  tags = merge(var.context.tags, { Name = "${var.context.id}-docdb-subnet-group" })
}

# ─── DocumentDB Cluster ──────────────────────────────────────────────────────────
# CONTRACT: This is the production path — do NOT delete it; nothing below
# replaces it on real AWS.
# WORKAROUND(local): manage_cluster_via_provider = false. The native resource
# aborts the apply against Floci with a 403 InvalidClientTokenId while the
# identical boto3 CreateDBCluster succeeds, so the fallback below runs instead.
# See [[awscli-fallback-for-floci]]
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
# WORKAROUND(local): Floci backs this with one standalone mongo:7.0 container, no
# replica set — do NOT rely on multi-document transactions locally.
# See [[floci-sqs-lambda-docdb-support]]
resource "aws_docdb_cluster_instance" "this" {
  count = var.manage_cluster_via_provider ? 1 : 0

  identifier         = local.instance_identifier
  cluster_identifier = aws_docdb_cluster.this[0].id
  instance_class     = var.instance_class
  engine             = "docdb"

  tags = merge(var.context.tags, { Name = local.instance_identifier })
}

# ─── DocumentDB Cluster — Floci fallback (bypasses the aws provider) ─────────────
# WORKAROUND(local): Creates the cluster with a plain boto3 call outside
# Terraform's resource lifecycle, so the provider's request signing never runs.
# CONTRACT: The script must stay idempotent (lookup-then-create, *AlreadyExists
# treated as success) — `make bootstrap` rebuilds this routinely and
# terraform_data re-runs the provisioner whenever `input` changes.
# See [[awscli-fallback-for-floci]]
resource "terraform_data" "cluster_via_cli" {
  count = var.manage_cluster_via_provider ? 0 : 1

  # CONTRACT: Everything the script must re-run for. terraform_data replaces when
  # `input` changes, and the subnet-group entry also makes this depend on
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
      # WARNING: Keep the password OUT of `input` — terraform_data.input lands in
      # state in plaintext, and a rotation must not trigger a cluster recreation.
      MASTER_PASSWORD    = var.master_password
      ENGINE_VERSION     = self.input.engine_version
      INSTANCE_CLASS     = self.input.instance_class
      SUBNET_GROUP_NAME  = self.input.subnet_group_name
      SECURITY_GROUP_IDS = self.input.security_group_ids
      STATE_FILE         = self.input.state_file
      ENDPOINT_URL       = var.aws_cli_endpoint_url
      AWS_REGION         = var.region
      # WHY: Traceability only — the script always runs. Empty (the default) means
      # "record nothing", which the script treats as legitimate, not an error.
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
# CONTRACT: Do NOT add `aws_ssm_parameter` here ungated. They fail against Floci
# with `UnrecognizedClientException` — the same provider-signing failure that
# forced the awscli-fallback above — and nothing reads them: every consumer takes
# host/port from `terraform output`. If production needs them, gate them the way
# the cluster is gated. See [[awscli-fallback-for-floci]]
