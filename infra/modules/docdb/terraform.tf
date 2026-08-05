terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.31.0"
    }
    # Used only by the var.manage_cluster_via_provider = false fallback (Floci
    # local) to read back the cluster descriptor written by the boto3 local-exec
    # script. Unused when manage_cluster_via_provider = true (prod) — the local
    # provider needs no configuration.
    local = {
      source = "hashicorp/local"
    }
  }
}
