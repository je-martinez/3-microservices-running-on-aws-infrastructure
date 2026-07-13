module "this" {
  source = "cloudposse/label/null"
  # Pin to the version agreed in ADR-0001
  version = "0.25.0"

  namespace   = var.namespace
  environment = var.environment
  stage       = var.stage
  name        = var.name
  attributes  = var.attributes
  tags        = var.tags
}
