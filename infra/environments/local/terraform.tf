terraform {
  required_version = ">= 1.7"

  backend "s3" {}

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # WORKAROUND(local): Keep this pin. Provider 5.100+ fails
      # aws_cognito_user_pool_client with "Provider produced inconsistent
      # result" against Floci. The pin narrows but does not eliminate that
      # resource's failure — the actual fix is modules/cognito's
      # manage_client_via_provider = false fallback.
      # See [[awscli-fallback-for-floci]]
      version = "= 5.31.0"
    }
    # WORKAROUND(local): No `postgresql` provider here — see providers.tf.
    # `local` is required by modules/cognito's awscli fallback, whose
    # data.local_file reads back the client id the script writes.
    local = {
      source = "hashicorp/local"
    }
  }
}
