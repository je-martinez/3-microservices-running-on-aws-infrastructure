terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Same pin as every other module in this repo: Floci does not tolerate
      # provider v5.100 (see environments/local/terraform.tf for the full
      # finding). Kept identical so the root module resolves one version.
      version = "= 5.31.0"
    }
    # Packages the built dist/ output into the Lambda deployment zip, matching
    # the pattern already used by modules/cognito for the pre-token Lambda.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}
