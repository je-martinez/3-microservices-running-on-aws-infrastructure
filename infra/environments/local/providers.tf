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
    lambda           = "http://localhost:4566"
    logs             = "http://localhost:4566"
    rds              = "http://localhost:4566"
    route53          = "http://localhost:4566"
    servicediscovery = "http://localhost:4566"
    secretsmanager   = "http://localhost:4566"
    sts              = "http://localhost:4566"
  }
}

# No `provider "postgresql"` block here (LOCAL ONLY — see main.tf's
# `manage_app_user = false` comment on module.rds_aurora): Terraform configures
# every declared provider BEFORE creating the resources a plan touches, but the
# Floci-proxied Postgres endpoint for this cluster does not exist until AFTER
# `aws_rds_cluster.this` is created — a chicken-and-egg no default value can
# ever resolve on a clean apply (the endpoint/proxy port is assigned per-run).
# The least-privilege app DB user is created post-apply by bootstrap.sh instead
# (connects directly to the Floci-proxied endpoint once it exists). Production
# has no such problem (stable, pre-existing Aurora DNS endpoint), so the
# module's `postgresql_*` resources and its own `postgresql` provider
# requirement are untouched — see environments/production/providers.tf.
