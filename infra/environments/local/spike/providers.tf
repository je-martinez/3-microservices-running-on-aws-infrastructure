terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # v5.100 crashes Ministack 1.3.69 with nil pointer panic. Pin to 5.31.0.
      version = "= 5.31.0"
    }
  }
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    apigateway   = "http://localhost:4566"
    apigatewayv2 = "http://localhost:4566"
    cognitoidp   = "http://localhost:4566"
    ec2          = "http://localhost:4566"
    ecs          = "http://localhost:4566"
    iam          = "http://localhost:4566"
    logs         = "http://localhost:4566"
    sts          = "http://localhost:4566"
  }
}
