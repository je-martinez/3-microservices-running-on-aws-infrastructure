locals {
  family = "${var.context.id}-${var.name}"
  ports  = distinct(concat([var.container_port], var.extra_ports, [for l in values(var.listeners) : l.container_port]))
}

# WARNING: Floci ignores `awslogs-group` and writes to /ecs/<family>; the group is
# named that way so both agree. See [[2026-10-02-floci-preprod-environment-design]]
resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${local.family}"
  retention_in_days = 1
}

resource "aws_ecs_task_definition" "this" {
  family                   = local.family
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  execution_role_arn       = var.execution_role_arn
  container_definitions = jsonencode([{
    name         = var.name
    image        = var.image
    essential    = true
    portMappings = [for p in local.ports : { containerPort = p, protocol = "tcp" }]
    secrets      = var.secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = var.name
      }
    }
  }])
  tags = var.context.tags
}

resource "aws_lb_target_group" "this" {
  for_each = var.listeners
  # WHY: TG names cap at 32 chars; a short hash of the context keeps them unique
  # without truncating "otel-collector-otlp" and "-rum" into the same name.
  name             = "${substr(md5(var.context.id), 0, 6)}-${var.name}-${each.key}"
  port             = each.value.container_port
  protocol         = "HTTP"
  protocol_version = each.value.protocol_version
  target_type      = "ip"
  vpc_id           = var.vpc_id
  health_check {
    path    = each.value.health_path
    matcher = each.value.protocol_version == "GRPC" ? "0-99" : "200-499"
  }
}

resource "aws_lb_listener" "this" {
  for_each          = var.listeners
  load_balancer_arn = var.alb_arn
  port              = each.value.port
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[each.key].arn
  }
}

resource "aws_ecs_service" "this" {
  name            = var.name
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  propagate_tags  = "NONE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = true
  }

  dynamic "load_balancer" {
    for_each = var.listeners
    content {
      target_group_arn = aws_lb_target_group.this[load_balancer.key].arn
      container_name   = var.name
      container_port   = load_balancer.value.container_port
    }
  }

  depends_on = [aws_lb_listener.this]
}
