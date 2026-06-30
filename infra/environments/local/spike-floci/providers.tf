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
  # approach this spike validates.
  endpoints {
    apigateway       = "http://localhost:4566"
    apigatewayv2     = "http://localhost:4566"
    cognitoidp       = "http://localhost:4566"
    ec2              = "http://localhost:4566"
    ecs              = "http://localhost:4566"
    elbv2            = "http://localhost:4566"
    iam              = "http://localhost:4566"
    logs             = "http://localhost:4566"
    route53          = "http://localhost:4566"
    servicediscovery = "http://localhost:4566"
    sts              = "http://localhost:4566"
  }
}
