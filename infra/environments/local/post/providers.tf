provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  s3_use_path_style           = true
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    rds            = "http://localhost:4566"
    secretsmanager = "http://localhost:4566"
    sts            = "http://localhost:4566"
  }
}

# Configured with the master password from the secret (local.master) — never a
# variable. Host/port are the Floci-proxied endpoint.
#
# host = "localhost" because phase 2 runs on the HOST (make step), reaching
# Floci's published proxy port. If phase 2 ever runs in-network, switch to
# "floci". Prod reads host/port from the secret (local.master.host/port).
provider "postgresql" {
  host      = "localhost"
  port      = local.pg_port
  database  = var.pg_database
  username  = local.master.username
  password  = local.master.password
  sslmode   = "disable"
  superuser = false
}

provider "mysql" {
  endpoint = "localhost:${local.mysql_port}"
  username = local.master.username
  password = local.master.password
  tls      = "false"
}
