# Wait for each enabled engine's DB to accept connections before creating any
# app-user. Reuses the terraform_data + local-exec pattern from modules/cognito.
#
# The gate probes over the compose network, so its host is the `floci` service
# name (not "localhost" — the check runs in a container ON the network), while
# the port stays the same Floci proxy port the providers use host-side.
resource "terraform_data" "wait_for_db" {
  for_each = toset(var.enabled_app_users)

  # One gate per ENGINE, not per app-user: orders_app and tracking_app share the
  # same MySQL cluster, so a single "mysql" probe covers both.
  input = {
    host   = "floci"
    port   = each.key == "postgres" ? local.pg_port : local.mysql_port
    engine = each.key
  }

  # CONTRACT: abspath, and the repo venv's interpreter via var.python_bin —
  # never plain `python3` off PATH, which may resolve into an unrelated venv.
  # path.module is "." at the root and does not resolve from the provisioner's
  # cwd. See [[scripting-language]]
  provisioner "local-exec" {
    command     = "${var.python_bin} ${abspath("${path.module}/scripts/wait_for_db.py")} ${self.input.host} ${self.input.port} ${self.input.engine}"
    interpreter = ["/usr/bin/env", "bash", "-c"]
    environment = {
      # Traceability only: the gate always probes, and a recorded run never
      # substitutes for one. Set explicitly rather than relying on the
      # Makefile's exported value, so a by-hand `terraform apply` records too.
      EXECUTION_LOG_TABLE = var.execution_log_table
    }
  }
}
