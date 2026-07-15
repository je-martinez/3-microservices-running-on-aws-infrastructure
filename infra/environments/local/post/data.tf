# Phase-1 outputs (endpoints + master secret ARN). Local backend file.
data "terraform_remote_state" "phase1" {
  backend = "local"
  config  = { path = "../terraform.tfstate" }
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

  # Floci proxy ports (7000-7099, assigned at apply time). Postgres = 7001,
  # Orders MySQL = 7002 (verified). These are Floci-local; prod reads host/port
  # from the secret itself (local.master.host / local.master.port).
  pg_port    = var.pg_port
  mysql_port = var.mysql_port
}
