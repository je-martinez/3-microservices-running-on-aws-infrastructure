# Label for the post-effects resources' secret names/tags.
module "label_post" {
  source      = "../../../modules/label"
  namespace   = "3mrai"
  environment = "local"
  name        = "post"
}

# Users app-user (Postgres). Enabled locally — Floci supports it.
module "users_app" {
  count  = contains(var.enabled_app_users, "postgres") ? 1 : 0
  source = "../../../modules/db-app-user"

  context         = { id = "post-${module.label_post.id}", tags = module.label_post.tags }
  engine          = "postgres"
  database_name   = var.pg_database
  app_username    = "users_app"
  master_username = var.master_username
  db_host         = local.pg_host
  db_port         = local.pg_port

  depends_on = [terraform_data.wait_for_db]
}

# Orders app-user (MySQL). Enabled locally since 2026-07-30: the petoju/mysql
# provider was re-verified against Floci and no longer hangs (see
# var.enabled_app_users).
module "orders_app" {
  count  = contains(var.enabled_app_users, "mysql") ? 1 : 0
  source = "../../../modules/db-app-user"

  context         = { id = "post-${module.label_post.id}", tags = module.label_post.tags }
  engine          = "mysql"
  database_name   = var.mysql_database
  app_username    = "orders_app"
  master_username = var.master_username
  db_host         = local.mysql_host
  db_port         = local.mysql_port

  # Both gates, and they are independent of each other: wait_for_db proves the
  # endpoint answers, mysql_provider_grants proves the provider's identity may
  # create users at all (see grants.tf). Postgres needs only the first.
  depends_on = [terraform_data.wait_for_db, terraform_data.mysql_provider_grants]
}

# Tracking app-user (MySQL). Shares the Orders cluster (same host/port, hence the
# same wait_for_db gate keyed on "mysql") but a DIFFERENT database, so the grant
# is scoped to `tracking`.* only — orders_app cannot read tracking and vice versa.
# Same SELECT/INSERT/UPDATE, no DELETE (ADR-0004).
module "tracking_app" {
  count  = contains(var.enabled_app_users, "mysql") ? 1 : 0
  source = "../../../modules/db-app-user"

  context         = { id = "post-${module.label_post.id}", tags = module.label_post.tags }
  engine          = "mysql"
  database_name   = var.tracking_database
  app_username    = "tracking_app"
  master_username = var.master_username
  db_host         = local.mysql_host
  db_port         = local.mysql_port

  # Same two gates as orders_app — same cluster, same provider identity.
  depends_on = [terraform_data.wait_for_db, terraform_data.mysql_provider_grants]
}
