terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Pinned to the version proven against Floci (see
      # environments/local/terraform.tf for the full finding). Do not bump.
      version = "= 5.31.0"
    }
  }

  # NO `backend "s3"` block here — this root is the create-once bootstrap that
  # provisions the remote-state bucket/table consumed by every other root's
  # `backend.hcl` (Task 2). Putting it on the remote backend itself would be
  # the chicken-and-egg this root exists to avoid. State stays LOCAL by design.
}
