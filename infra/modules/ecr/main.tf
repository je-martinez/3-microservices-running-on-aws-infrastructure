resource "aws_ecr_repository" "this" {
  for_each             = var.repositories
  name                 = "${var.context.id}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true
  tags                 = var.context.tags
}
