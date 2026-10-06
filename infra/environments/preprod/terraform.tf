terraform {
  required_version = ">= 1.7"
  # WHY: Local state — the emulator dies with every preprod-down, so a backend
  # bucket inside it would only add a bootstrap step.
  backend "local" {}
  required_providers {
    aws    = { source = "hashicorp/aws", version = "= 5.31.0" }
    local  = { source = "hashicorp/local" }
    random = { source = "hashicorp/random" }
  }
}
