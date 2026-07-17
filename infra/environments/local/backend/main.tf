# ─── Label ───────────────────────────────────────────────────────────────────
module "label" {
  source      = "../../../modules/label"
  namespace   = "3mrai"
  environment = "local"
  name        = "tfstate"
}

# ─── Remote state bootstrap (S3 bucket + DynamoDB lock table) ────────────────
# This root keeps LOCAL state on purpose (see terraform.tf) — it creates the
# resources every other root's `backend "s3"` block (Task 2) points at.
module "tf_backend" {
  source  = "../../../modules/tf-backend"
  context = { id = module.label.id, tags = module.label.tags }
}
