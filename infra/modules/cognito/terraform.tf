terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
    # Used only by the var.manage_client_via_provider = false fallback
    # (Floci local) to read back the client id written by the awscli
    # local-exec script. No-op / unused when manage_client_via_provider =
    # true (prod, Ministack) — the local provider needs no configuration.
    local = {
      source = "hashicorp/local"
    }
  }
}
