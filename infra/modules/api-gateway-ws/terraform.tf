terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Same pin as every other module in this repo: Floci does not tolerate
      # provider v5.100 (see environments/local/terraform.tf for the full
      # finding). Kept identical so the root module resolves one version.
      version = "= 5.31.0"
    }
    # Packages each built dist/ entrypoint into its own Lambda deployment zip,
    # matching the pattern already used by modules/lambda and modules/cognito
    # for the pre-token Lambda.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}
