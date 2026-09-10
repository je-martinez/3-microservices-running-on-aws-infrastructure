# Public asset hosting for the email templates: a bucket, plus the sync that
# optimises assets/ into it and writes the manifest the templates read.
#
# CONTRACT: This belongs in phase 2, NOT phase 1. Phase 1 cannot be applied
# twice at all (Floci's UpdateTags breaks for API GW v2 stages and RDS
# clusters), so anything re-runnable placed there forces a full teardown to
# change a logo. Phase 2 has its own state and re-applies cleanly. Day to day,
# `make assets-sync` re-uploads without Terraform.
# See [[floci-rds-apigw-limits]]

module "assets_bucket" {
  source = "../../../modules/assets-bucket"

  context = { id = "post-${module.label_post.id}", tags = module.label_post.tags }

  # Local opts IN to public read, explicitly. The module defaults to private
  # because production fronts the bucket with CloudFront + OAC; Floci emulates
  # no CloudFront data plane, so direct public bucket access is the only thing
  # that produces a fetchable URL here. Full argument on the module's
  # var.public_read.
  public_read = true

  # Path-style: Floci serves every bucket on its single :4566 port, so the
  # public URL is <endpoint>/<bucket>/<key>. Null (the default) would produce
  # the virtual-host AWS form, which does not resolve locally.
  endpoint_url = "http://localhost:4566"
}

# Optimise + upload + write assets/assets.manifest.json.
#
# CONTRACT: The script must stay a full overwrite (resize -> put_object ->
# rewrite the manifest) so a re-apply converges rather than accumulating.
# See [[awscli-fallback-for-floci]]
resource "terraform_data" "assets_sync" {
  # Re-run when the target changes. The `triggers_replace` shape (rather than
  # `input`) because there is nothing downstream that reads a value from here —
  # this resource exists only to run its provisioner, and it should re-run when
  # the bucket it uploads to is recreated (which `make clean` does routinely).
  triggers_replace = {
    bucket   = module.assets_bucket.bucket_name
    base_url = module.assets_bucket.public_base_url
  }

  # abspath so the script resolves regardless of the local-exec working dir, and
  # var.python_bin (the repo venv, ABSOLUTE) rather than `python3` off PATH —
  # a developer's shell may already sit inside an unrelated venv and an apply
  # must never pick up a stray interpreter. Same reasoning as gate.tf/grants.tf.
  provisioner "local-exec" {
    command = join(" ", [
      var.python_bin,
      abspath("${path.module}/../../../modules/assets-bucket/scripts/sync_assets.py"),
      "--bucket", self.triggers_replace.bucket,
      "--base-url", self.triggers_replace.base_url,
    ])
    interpreter = ["/usr/bin/env", "bash", "-c"]
    environment = {
      # Traceability only: the sync always runs, and a recorded run never
      # substitutes for one. Set explicitly rather than relying on the
      # Makefile's exported value, so a by-hand `terraform apply` records too.
      EXECUTION_LOG_TABLE = var.execution_log_table
    }
  }
}
