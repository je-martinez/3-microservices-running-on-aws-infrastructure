terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # FINDING (2026-06-29): Floci does NOT tolerate provider v5.100 — apply of
      # aws_cognito_user_pool_client fails with "Provider produced inconsistent
      # result" (provider expects analytics_configuration / refresh_token_rotation
      # blocks that Floci does not return). Same class of modern-provider mismatch
      # Ministack hit. Pinned to 5.31.0 (the version proven on the Ministack spike).
      version = "= 5.31.0"
    }
  }
}
