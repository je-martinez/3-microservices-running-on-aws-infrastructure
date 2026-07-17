bucket                      = "3mrai-local-tfstate-state"
key                         = "local/phase1/terraform.tfstate"
region                      = "us-east-1"
dynamodb_table              = "3mrai-local-tfstate-lock"

# Force Terraform to communicate with Floci instead of real AWS
endpoint                    = "http://localhost:4566"
sts_endpoint                = "http://localhost:4566"
dynamodb_endpoint           = "http://localhost:4566"

skip_credentials_validation = true
skip_metadata_api_check     = true
skip_region_validation      = true
use_path_style              = true # Required for local S3 emulation
