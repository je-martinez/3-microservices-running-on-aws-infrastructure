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
      #
      # UPDATE (verified again on a from-scratch apply): pinning to 5.31.0
      # narrows the failure but does NOT eliminate it — this exact version
      # still aborts aws_cognito_user_pool_client's CREATE with the same
      # "block count changed from 0 to 1" error. The pin stays (it avoids a
      # confirmed WORSE failure on 5.100+), but the actual fix for the
      # client resource is modules/cognito's manage_client_via_provider =
      # false fallback (see environments/local/main.tf, module "cognito").
      version = "= 5.31.0"
    }
    # No `postgresql` provider here — LOCAL ONLY. See providers.tf and
    # main.tf's `manage_app_user = false` comment: the module's postgresql_*
    # resources (and its own `postgresql` required_provider, which stays
    # unchanged) are disabled for this environment because the provider
    # cannot be configured with an endpoint that doesn't exist yet on a clean
    # apply. bootstrap.sh creates the app user post-apply instead.
    #
    # `local` — required by modules/cognito's manage_client_via_provider =
    # false fallback (data.local_file reads back the client id the awscli
    # local-exec script writes). See modules/cognito/terraform.tf.
    local = {
      source = "hashicorp/local"
    }
  }
}
