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

  # abspath so the script resolves regardless of the local-exec working dir
  # (path.module is "." at the root, which does not reliably resolve from the
  # provisioner's cwd). The interpreter is the repo venv's python, passed in as
  # var.python_bin rather than derived here: the Makefile already knows the
  # absolute path, and hardcoding a relative depth from this module is exactly
  # the kind of thing that breaks silently when a file moves. Never `python3`
  # off PATH — a developer's shell may sit inside an unrelated venv.
  provisioner "local-exec" {
    command     = "${var.python_bin} ${abspath("${path.module}/scripts/wait_for_db.py")} ${self.input.host} ${self.input.port} ${self.input.engine}"
    interpreter = ["/usr/bin/env", "bash", "-c"]
  }
}
