provider "aws" {
  region     = var.region
  access_key = "test"
  secret_key = "test"

  # LocalStack/Floci compatibility flags (same family as Ministack).
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  # Only the services this root's resources need: S3 (state bucket) and
  # DynamoDB (lock table). sts/iam are included because the provider probes
  # them during credential/account-id resolution even with the skip_* flags.
  endpoints {
    s3       = "http://localhost:4566"
    dynamodb = "http://localhost:4566"
    sts      = "http://localhost:4566"
    iam      = "http://localhost:4566"
  }
}
