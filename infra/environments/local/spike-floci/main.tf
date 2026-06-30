# ============================================================
# Floci auth-chain spike — adapted from infra/environments/local/spike/main.tf
# Validates: Cognito JWT → API GW v2 → ECS Nginx → spike-backend, on Floci.
# Built incrementally; this file grows per task. NO module usage (self-contained
# spike, mirrors the Ministack spike layout for a clean A/B comparison).
# ============================================================

# ── Cognito ─────────────────────────────────────────────────
resource "aws_cognito_user_pool" "spike" {
  name = "3mrai-local-floci-spike"

  password_policy {
    minimum_length    = 8
    require_lowercase = false
    require_numbers   = false
    require_symbols   = false
    require_uppercase = false
  }
}

resource "aws_cognito_user_pool_client" "spike" {
  name         = "3mrai-local-floci-spike-client"
  user_pool_id = aws_cognito_user_pool.spike.id

  explicit_auth_flows = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = false

  # FINDING (2026-06-29): Floci returns AnalyticsConfiguration:{} and
  # RefreshTokenRotation:{} as EMPTY objects on create/describe. The AWS provider
  # reads those as "block present" (count 0→1) and aborts every apply/modify with
  # "Provider produced inconsistent result". Ignoring these computed blocks keeps
  # the resource stable across applies. The client itself is created correctly and
  # works (tokens mint + authorizer validates) — this is purely a fidelity gap in
  # Floci's Cognito response shape, not a real failure.
  lifecycle {
    ignore_changes = [
      analytics_configuration,
    ]
  }
}

# ── IAM — ECS task execution role ───────────────────────────
resource "aws_iam_role" "spike_ecs_execution" {
  name = "3mrai-local-floci-spike-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "spike_ecs_execution_policy" {
  role       = aws_iam_role.spike_ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ── Networking ──────────────────────────────────────────────
resource "aws_vpc" "spike" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "3mrai-local-floci-spike-vpc" }
}

resource "aws_subnet" "spike_a" {
  vpc_id                  = aws_vpc.spike.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = true
  tags                    = { Name = "3mrai-local-floci-spike-subnet-a" }
}

resource "aws_subnet" "spike_b" {
  vpc_id                  = aws_vpc.spike.id
  cidr_block              = "10.0.2.0/24"
  availability_zone       = "us-east-1b"
  map_public_ip_on_launch = true
  tags                    = { Name = "3mrai-local-floci-spike-subnet-b" }
}

resource "aws_security_group" "spike" {
  name        = "3mrai-local-floci-spike-sg"
  description = "Allow all traffic for the Floci spike"
  vpc_id      = aws_vpc.spike.id
  tags        = { Name = "3mrai-local-floci-spike-sg" }
}

# Floci spike: try the SEPARATE rule resources (Ministack crashed on these and
# forced inline ingress/egress). If Floci also fails, replace these two resources
# with inline `ingress {}`/`egress {}` blocks in the SG above and record the finding.
resource "aws_vpc_security_group_ingress_rule" "spike_all" {
  security_group_id = aws_security_group.spike.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "spike_all" {
  security_group_id = aws_security_group.spike.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ── ECS — Nginx reverse proxy ───────────────────────────────
resource "aws_ecs_cluster" "spike" {
  name = "3mrai-local-floci-spike-cluster"
  tags = { Name = "3mrai-local-floci-spike-cluster" }
}

resource "aws_cloudwatch_log_group" "spike" {
  name              = "/ecs/3mrai-local-floci-spike"
  retention_in_days = 1
}

resource "aws_ecs_task_definition" "spike_nginx" {
  family                   = "3mrai-local-floci-spike-nginx"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.spike_ecs_execution.arn

  container_definitions = jsonencode([{
    name      = "nginx"
    image     = "nginx:alpine"
    essential = true

    portMappings = [{ containerPort = 80, hostPort = 80, protocol = "tcp" }]

    # Write nginx.conf at start, then exec nginx. resolver 127.0.0.11 is Docker's
    # embedded DNS; `set $backend` forces per-request resolution of spike-backend
    # (resolved by container_name on 3mrai_3mrai-network).
    command = [
      "sh", "-c",
      join(" && ", [
        "printf 'server {\\n  listen 80;\\n  location / {\\n    resolver 127.0.0.11 valid=5s;\\n    set $backend spike-backend;\\n    proxy_pass http://$backend:${var.spike_backend_port};\\n    proxy_set_header Host $host;\\n    proxy_set_header X-Real-IP $remote_addr;\\n  }\\n}\\n' > /etc/nginx/conf.d/default.conf",
        "nginx -g 'daemon off;'"
      ])
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.spike.name
        "awslogs-region"        = "us-east-1"
        "awslogs-stream-prefix" = "nginx"
      }
    }
  }])
}

resource "aws_ecs_service" "spike_nginx" {
  name            = "3mrai-local-floci-spike-nginx"
  cluster         = aws_ecs_cluster.spike.id
  task_definition = aws_ecs_task_definition.spike_nginx.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [aws_subnet.spike_a.id, aws_subnet.spike_b.id]
    security_groups  = [aws_security_group.spike.id]
    assign_public_ip = true
  }

  # DNS-first: register the task in Cloud Map so it gets a stable DNS name
  # (nginx.spike.local), removing the need to discover the container IP.
  service_registries {
    registry_arn = aws_service_discovery_service.nginx.arn
  }

  depends_on = [aws_iam_role_policy_attachment.spike_ecs_execution_policy]
}

# ── Cloud Map (service discovery) — DNS-first ───────────────
# Goal: give the Nginx ECS service a STABLE DNS name so the API GW integration
# URI is known at apply time — eliminating the docker-inspect/IP-patch bootstrap.
# If Floci does not support servicediscovery or the ECS service registration,
# the smoke-test falls back to IP discovery and we record the gap.
resource "aws_service_discovery_private_dns_namespace" "spike" {
  name = "spike.local"
  vpc  = aws_vpc.spike.id
}

resource "aws_service_discovery_service" "nginx" {
  name = "nginx"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.spike.id
    dns_records {
      type = "A"
      ttl  = 10
    }
    routing_policy = "MULTIVALUE"
  }
}

# ── API Gateway v2 (HTTP) + JWT authorizer ──────────────────
resource "aws_apigatewayv2_api" "spike" {
  name          = "3mrai-local-floci-spike-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_authorizer" "spike" {
  api_id           = aws_apigatewayv2_api.spike.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "3mrai-local-floci-spike-jwt"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.spike.id]
    # FINDING (2026-06-29): Floci issues IdTokens with iss =
    # "http://localhost:4566/<pool-id>" (its own endpoint), NOT the AWS Cognito
    # URL Ministack used ("https://cognito-idp.<region>.amazonaws.com/<pool-id>").
    # The authorizer issuer MUST match the token's iss claim exactly, so it points
    # at Floci's endpoint. This is the key Cognito-issuer difference vs Ministack.
    issuer = "http://localhost:4566/${aws_cognito_user_pool.spike.id}"
  }
}

resource "aws_apigatewayv2_integration" "spike_nginx" {
  api_id             = aws_apigatewayv2_api.spike.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  connection_type    = "INTERNET"

  # STABLE-DNS approach: target a fixed Docker-DNS alias (`nginx-stable`) that
  # bootstrap.sh attaches to the nginx ECS container after each apply. Because the
  # alias is constant, this integration URI NEVER changes — it is correct at apply
  # time and needs no post-apply patch. This replaces the old docker-inspect + IP
  # update-integration step. Floci's API GW resolves the alias via Docker embedded
  # DNS (verified). Cloud Map / Route53 cannot be used: Floci's Route53 is
  # management-plane only (no DNS resolution) and ECS tasks are not registered in
  # Cloud Map — so a Docker-native alias is the working "stable DNS" mechanism.
  integration_uri = "http://${var.nginx_stable_alias}/"
}

resource "aws_apigatewayv2_route" "spike_protected" {
  api_id             = aws_apigatewayv2_api.spike.id
  route_key          = "GET /protected"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.spike.id
  target             = "integrations/${aws_apigatewayv2_integration.spike_nginx.id}"
}

resource "aws_apigatewayv2_route" "spike_public" {
  api_id             = aws_apigatewayv2_api.spike.id
  route_key          = "GET /public"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.spike_nginx.id}"
}

resource "aws_apigatewayv2_stage" "spike" {
  api_id      = aws_apigatewayv2_api.spike.id
  name        = "$default"
  auto_deploy = true
}
