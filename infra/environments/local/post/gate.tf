# Wait for each enabled engine's DB to accept connections before creating any
# app-user. Reuses the terraform_data + local-exec pattern from modules/cognito.
#
# The gate probes over the compose network, so its host is the `floci` service
# name (not "localhost" — the check runs in a container ON the network), while
# the port stays the same Floci proxy port the providers use host-side.
resource "terraform_data" "wait_for_db" {
  for_each = toset(var.enabled_app_users)

  input = {
    host   = each.key == "postgres" ? "floci" : "floci"
    port   = each.key == "postgres" ? local.pg_port : local.mysql_port
    engine = each.key
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/wait-for-db.sh ${self.input.host} ${self.input.port} ${self.input.engine}"
    interpreter = ["/usr/bin/env", "bash"]
  }
}
