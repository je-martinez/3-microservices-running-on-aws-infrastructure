provider "aws" {
  region     = "us-east-1"
  access_key = "test"
  secret_key = "test"

  # LocalStack / Ministack compatibility flags
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true

  # Ministack quirk: the correct attribute name is skip_requesting_account_id
  # (NOT skip_requested_account_id).  Using the wrong name causes silent failures
  # where the provider calls real AWS to resolve the account ID.
  # Source: docs/lessons/ministack-auth-chain-spike-findings.md, finding #9.
  skip_requesting_account_id = true

  # All services used by the local composition must be declared here.
  # If a service is missing, Terraform will call real AWS endpoints instead of
  # Ministack — a silent and hard-to-debug failure.
  # Source: docs/lessons/ministack-auth-chain-spike-findings.md, finding #10.
  endpoints {
    apigateway     = "http://localhost:4566"
    apigatewayv2   = "http://localhost:4566"
    cognitoidp     = "http://localhost:4566"
    ec2            = "http://localhost:4566"
    ecs            = "http://localhost:4566"
    elbv2          = "http://localhost:4566"
    iam            = "http://localhost:4566"
    logs           = "http://localhost:4566"
    rds            = "http://localhost:4566"
    secretsmanager = "http://localhost:4566"
    sts            = "http://localhost:4566"
  }
}
