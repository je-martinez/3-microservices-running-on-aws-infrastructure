resource "aws_lb" "this" {
  name               = "${var.context.id}-alb"
  internal           = true
  load_balancer_type = "application"
  subnets            = var.subnet_ids
  security_groups    = var.security_group_ids
  tags               = var.context.tags
}
