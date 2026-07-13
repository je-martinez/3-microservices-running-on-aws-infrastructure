locals {
  nginx_dir = var.nginx_config_host_path != "" ? var.nginx_config_host_path : abspath("${path.module}/nginx")
}

# ─── ECS Cluster ─────────────────────────────────────────────────────────────
resource "aws_ecs_cluster" "this" {
  name = "${var.context.id}-cluster"
  tags = merge(var.context.tags, { Name = "${var.context.id}-cluster" })
}

# ─── CloudWatch Log Group ─────────────────────────────────────────────────────
resource "aws_cloudwatch_log_group" "nginx" {
  name              = "/ecs/${var.context.id}"
  retention_in_days = var.log_retention_days
  tags              = var.context.tags
}

# ─── ECS Execution Role ───────────────────────────────────────────────────────
resource "aws_iam_role" "ecs_execution" {
  name = "${var.context.id}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "ecs-tasks.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }
    ]
  })

  tags = var.context.tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution_policy" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ─── ECS Task Definition (nginx:alpine reverse proxy) ────────────────────────
#
# The nginx config (auth.js + nginx.conf, checked into infra/modules/compute/nginx/)
# is bind-mounted from local.nginx_dir into the container at /etc/nginx/mounted/.
# ADR-0016 assumed Ministack ECS could not mount host volumes; Floci does
# support them, so nginx now starts directly against the mounted config instead
# of writing conf.d/default.conf via a printf/shell command.
#
# nginx uses Docker's embedded DNS resolver (127.0.0.11) and a variable
# `$backend` so that the service name is resolved at request time — not at
# startup — which avoids "host not found" errors when the compose service
# restarts.  The backend name comes from var.backend_service_name (e.g.
# "users") and the port from var.backend_port (e.g. 3000).
resource "aws_ecs_task_definition" "nginx" {
  family                   = "${var.context.id}-nginx"
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([
    {
      name      = "nginx"
      image     = "nginx:alpine"
      essential = true

      command = ["nginx", "-c", "/etc/nginx/mounted/nginx.conf", "-g", "daemon off;"]

      mountPoints = [
        {
          sourceVolume  = "nginx-config"
          containerPath = "/etc/nginx/mounted"
          readOnly      = true
        }
      ]

      portMappings = [
        {
          containerPort = 80
          hostPort      = 80
          protocol      = "tcp"
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.nginx.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "nginx"
        }
      }
    }
  ])

  volume {
    name      = "nginx-config"
    host_path = local.nginx_dir
  }

  tags = var.context.tags
}

# ─── ECS Service ──────────────────────────────────────────────────────────────
#
# No ALB / target group: ALB is production-only per ADR-0016.  In local, the
# API Gateway integration target is the nginx task's private IP, patched by
# the JE-36 bootstrap after task launch.
resource "aws_ecs_service" "nginx" {
  name            = "${var.context.id}-nginx"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.nginx.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = true
  }

  # Tags are intentionally not propagated to tasks; Ministack ignores them and
  # propagate_tags triggers provider errors in some versions.
  propagate_tags = "NONE"

  tags = var.context.tags

  depends_on = [aws_iam_role_policy_attachment.ecs_execution_policy]
}
