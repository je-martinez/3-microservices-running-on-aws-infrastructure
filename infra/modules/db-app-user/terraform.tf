terraform {
  required_providers {
    aws        = { source = "hashicorp/aws" }
    postgresql = { source = "cyrilgdn/postgresql", version = "~> 1.22" }
    mysql      = { source = "petoju/mysql", version = "~> 3.0" }
    random     = { source = "hashicorp/random" }
  }
}
