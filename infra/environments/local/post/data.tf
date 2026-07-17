# Phase-1 outputs (endpoints + master secret ARN). Read from the S3 backend
# (bucket + lock table provisioned once, out of band — see backend.hcl).
data "terraform_remote_state" "phase1" {
  backend = "s3"
  config = {
    bucket = "3mrai-local-tfstate-state"
    key    = "local/phase1/terraform.tfstate"
    region = "us-east-1"

    # Force Terraform to communicate with Floci instead of real AWS
    endpoint          = "http://localhost:4566"
    dynamodb_endpoint = "http://localhost:4566"
    sts_endpoint      = "http://localhost:4566"

    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    use_path_style              = true
  }
}

# Master credentials, read BY ARN — never passed as a variable. jsondecoded in
# memory to configure the providers below. The secret_string lands in THIS
# root's (gitignored) state — inherent to any Terraform secret data source.
data "aws_secretsmanager_secret_version" "master" {
  secret_id = data.terraform_remote_state.phase1.outputs.secret_arn
}

locals {
  master = jsondecode(data.aws_secretsmanager_secret_version.master.secret_string)

  pg_host    = data.terraform_remote_state.phase1.outputs.db_writer_endpoint
  mysql_host = data.terraform_remote_state.phase1.outputs.orders_db_writer_endpoint

  # Floci proxy ports (7000-7099, assigned at apply time BY CREATION ORDER —
  # NOT stable, so Postgres/MySQL can flip between 7001/7002). These come in via
  # var.pg_port/var.mysql_port, which `make infra-up-post` DISCOVERS per-engine
  # (scripts/discover-db-port.sh, reading describe-db-clusters) and passes as
  # -var; the variable defaults (7001/7002) are only a fallback. These are
  # Floci-local; prod reads host/port from the secret (local.master.host/.port).
  pg_port    = var.pg_port
  mysql_port = var.mysql_port
}
