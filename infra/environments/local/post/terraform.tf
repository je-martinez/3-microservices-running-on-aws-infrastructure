terraform {
  required_version = ">= 1.7"

  required_providers {
    aws        = { source = "hashicorp/aws", version = "= 5.31.0" }
    postgresql = { source = "cyrilgdn/postgresql", version = "~> 1.22" }
    mysql      = { source = "petoju/mysql", version = "~> 3.0" }
    random     = { source = "hashicorp/random" }
  }
}
