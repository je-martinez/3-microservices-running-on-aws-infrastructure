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
    apigateway   = "http://localhost:4566"
    apigatewayv2 = "http://localhost:4566"
    cognitoidp   = "http://localhost:4566"
    # CONTRACT: Every AWS service this root touches needs an entry here. An
    # undeclared service is sent to REAL AWS, which rejects the test credentials
    # with `UnrecognizedClientException` — a message that reads like a Floci auth
    # problem but means the request never reached Floci.
    dynamodb = "http://localhost:4566"
    ec2      = "http://localhost:4566"
    ecs      = "http://localhost:4566"
    # CONTRACT: The provider's EventBridge service key is `events`, not
    # `eventbridge` — a wrong key is an undeclared service, see above.
    events           = "http://localhost:4566"
    elbv2            = "http://localhost:4566"
    iam              = "http://localhost:4566"
    lambda           = "http://localhost:4566"
    logs             = "http://localhost:4566"
    rds              = "http://localhost:4566"
    route53          = "http://localhost:4566"
    servicediscovery = "http://localhost:4566"
    secretsmanager   = "http://localhost:4566"
    ses              = "http://localhost:4566"
    sqs              = "http://localhost:4566"
    sts              = "http://localhost:4566"
  }
}

# WORKAROUND(local): Do NOT declare a `postgresql` provider here. Terraform
# configures every declared provider BEFORE creating resources, and the
# Floci-proxied endpoint does not exist until the cluster is created — no default
# resolves on a clean apply. Phase 2 creates the app user instead. Production has
# a stable Aurora endpoint and keeps the provider.
# See [[two-phase-terraform-apply]]
