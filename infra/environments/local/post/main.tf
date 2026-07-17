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

# Orders app-user (MySQL). DISABLED locally (Floci hangs the mysql provider);
# enabled in prod via enabled_app_users = ["postgres","mysql"].
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

  depends_on = [terraform_data.wait_for_db]
}
