provider "aws" {
  region     = "us-east-1"
  access_key = "test"
  secret_key = "test"

  # LocalStack/Floci compatibility flags (same family as Ministack).
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  # Every service used by this stack must be declared, else Terraform calls real
  # AWS. servicediscovery (Cloud Map) and route53 are included for the DNS-first
  # approach validated by the spike. rds and secretsmanager are added here because
  # the rds-aurora module (not exercised by the spike) provisions an Aurora cluster
  # and a Secrets Manager secret for the DB credentials (see rds-aurora/main.tf:
  # aws_secretsmanager_secret.db_credentials).
  endpoints {
    apigateway       = "http://localhost:4566"
    apigatewayv2     = "http://localhost:4566"
    cognitoidp       = "http://localhost:4566"
    ec2              = "http://localhost:4566"
    ecs              = "http://localhost:4566"
    elbv2            = "http://localhost:4566"
    iam              = "http://localhost:4566"
    logs             = "http://localhost:4566"
    rds              = "http://localhost:4566"
    route53          = "http://localhost:4566"
    servicediscovery = "http://localhost:4566"
    secretsmanager   = "http://localhost:4566"
    sts              = "http://localhost:4566"
  }
}

# postgresql provider: manages the least-privilege app DB user (rds-aurora
# module, manage_app_user = true). Floci does not expose a direct Postgres
# wire-protocol port for the Aurora cluster the way real AWS does; a local
# proxy port is required. Port 4566 below is a PLACEHOLDER — R4 discovers the
# real Floci-proxied Postgres port and reconciles this block accordingly.
# `init`/`validate` only; do NOT apply against this placeholder.
# Points at the Floci RDS proxy endpoint discovered after the cluster is created
# (aws rds describe-db-clusters → Endpoint/Port; Floci proxy range 7000-7099).
# Overridable via TF_VAR_pg_host / TF_VAR_pg_port since Floci may assign a
# different proxy IP/port on recreation.
provider "postgresql" {
  host      = var.pg_host
  port      = var.pg_port
  username  = var.db_username
  password  = var.db_password
  database  = var.db_name
  sslmode   = "disable"
  superuser = false
}
