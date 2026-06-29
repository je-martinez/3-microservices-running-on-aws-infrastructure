terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # v5.100 crashes Ministack 1.3.69 with nil pointer panic.
      # Pin to 5.31.0 exactly — do not upgrade without re-validating against
      # the current Ministack version (see docs/lessons/ministack-auth-chain-spike-findings.md).
      version = "= 5.31.0"
    }
  }

  # Local state is intentional here — this environment is ephemeral and
  # single-developer. Remote state is required for staging/production only.
  backend "local" {}
}
