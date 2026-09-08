# CONTRACT: The `mysql` provider's identity needs CREATE USER ON *.* and SELECT
# ON mysql.* before any app-user can be created. Without them this apply fails
# 1227 on CREATE USER, then 1142 diffing the grants it just wrote.
# Independent of terraform_data.wait_for_db — the gate needs no privileges, so
# the two run in parallel and both gate the MySQL app-user modules. Created only
# when the mysql engine is enabled. See [[two-phase-terraform-apply]]
resource "terraform_data" "mysql_provider_grants" {
  count = contains(var.enabled_app_users, "mysql") ? 1 : 0

  # Re-run whenever the cluster this targets changes. The script rediscovers the
  # port itself (Floci reassigns proxy ports by creation order), so this input
  # is the change signal, not the value passed.
  input = {
    host = local.mysql_host
    port = local.mysql_port
  }

  # abspath so the script resolves regardless of the local-exec working dir, and
  # var.python_bin (the repo venv, absolute) rather than `python3` off PATH —
  # same reasoning as gate.tf.
  provisioner "local-exec" {
    command     = "${var.python_bin} ${abspath("${path.module}/scripts/grant_mysql_provider_privileges.py")}"
    interpreter = ["/usr/bin/env", "bash", "-c"]
    environment = {
      # Traceability only: the grants are always re-issued (MySQL no-ops a grant
      # already held), and a recorded run never substitutes for one. Set
      # explicitly rather than relying on the Makefile's exported value, so a
      # by-hand `terraform apply` records too.
      EXECUTION_LOG_TABLE = var.execution_log_table
    }
  }
}
