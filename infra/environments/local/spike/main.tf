# ============================================================
# Ministack auth-chain spike v2 — NEW TOPOLOGY
#
# Validates the REAL local architecture:
#   Cognito JWT → API Gateway v2 JWT authorizer
#       → ECS task (Nginx reverse proxy, in Ministack as a real Docker container)
#           → proxy_pass http://spike-backend:8080
#               → spike-backend container in 3mrai_3mrai-network (HTTP 200)
#
# Key design decisions:
#   1. No ALB. Ministack only supports Lambda target type for ALB forwarding.
#      The API Gateway integration points directly to the Nginx container IP
#      on the compose network. The smoke test discovers that IP after ECS task
#      launch and updates the integration URI via the AWS CLI.
#
#   2. Nginx runs inside a Ministack ECS task as a real Docker container on
#      3mrai_3mrai-network. Its nginx.conf is injected via a shell entrypoint
#      (ENTRYPOINT sh -c "printf '...' > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'")
#      passed as the task `command`. This avoids needing a custom image or
#      volume mount (neither of which are easily available in Ministack ECS).
#
#   3. spike-backend is a compose service added to docker-compose.yml
#      (hashicorp/http-echo on port 8080, returning "spike-ok-via-nginx").
#      Nginx resolves it by Docker compose service name on 3mrai_3mrai-network.
#
#   4. API GW integration_uri is initially set to a placeholder
#      ("http://0.0.0.0:80/") and updated by the smoke test after the Nginx
#      container IP is known. This is a Ministack-only pattern; in real AWS
#      the integration URI is a stable ALB DNS name.
#
# Ministack quirks carried forward from v1:
#   - AWS provider must be pinned to = 5.31.0 (v5.100 crashes with nil pointer)
#   - aws_vpc_security_group_{ingress,egress}_rule crash → use inline rules
#   - JWT authorizer issuer = https://cognito-idp.us-east-1.amazonaws.com/<pool-id>
#   - API GW invoke_url uses a real AWS domain; local URL is
#     http://<api-id>.execute-api.localhost:4566
# ============================================================

# ------------------------------------------------------------
# Cognito
# ------------------------------------------------------------
resource "aws_cognito_user_pool" "spike" {
  name = "3mrai-local-spike"

  password_policy {
    minimum_length    = 8
    require_lowercase = false
    require_numbers   = false
    require_symbols   = false
    require_uppercase = false
  }
}

resource "aws_cognito_user_pool_client" "spike" {
  name         = "3mrai-local-spike-client"
  user_pool_id = aws_cognito_user_pool.spike.id

  explicit_auth_flows = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = false
}

# ------------------------------------------------------------
# IAM — ECS task execution role
# ------------------------------------------------------------
resource "aws_iam_role" "spike_ecs_execution" {
  name = "3mrai-local-spike-ecs-execution"

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

# ------------------------------------------------------------
# Networking — VPC, subnets, security group
# (kept minimal; Ministack requires them for awsvpc network mode)
# ------------------------------------------------------------
resource "aws_vpc" "spike" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "3mrai-local-spike-vpc" }
}

resource "aws_subnet" "spike_a" {
  vpc_id                  = aws_vpc.spike.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = true

  tags = { Name = "3mrai-local-spike-subnet-a" }
}

resource "aws_subnet" "spike_b" {
  vpc_id                  = aws_vpc.spike.id
  cidr_block              = "10.0.2.0/24"
  availability_zone       = "us-east-1b"
  map_public_ip_on_launch = true

  tags = { Name = "3mrai-local-spike-subnet-b" }
}

resource "aws_security_group" "spike" {
  name        = "3mrai-local-spike-sg"
  description = "Allow all traffic for spike testing"
  vpc_id      = aws_vpc.spike.id

  # Ministack quirk: aws_vpc_security_group_{ingress,egress}_rule resources
  # crash with a Go panic on Ministack 1.3.69. Use inline rules instead.
  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "3mrai-local-spike-sg" }
}

# ------------------------------------------------------------
# ECS — Nginx reverse proxy task
#
# Nginx runs inside a Ministack ECS task and proxies to spike-backend
# by Docker compose service name (DNS resolution on 3mrai_3mrai-network).
#
# Nginx config injection mechanism:
#   The nginx:alpine image is used. Its default entrypoint is `/docker-entrypoint.sh`.
#   We override `command` with a shell snippet that:
#     1. Writes /etc/nginx/conf.d/default.conf with the proxy_pass config.
#     2. Execs nginx -g 'daemon off;'
#   This avoids needing a custom image or a volume mount from the host.
#
# proxy_pass target: http://spike-backend:8080
#   spike-backend is a service in docker-compose.yml (hashicorp/http-echo on port
#   8080). Ministack launches ECS tasks as real Docker containers on
#   3mrai_3mrai-network, so Docker's embedded DNS resolves "spike-backend" by
#   compose service name. The smoke test verifies this explicitly.
# ------------------------------------------------------------
resource "aws_ecs_cluster" "spike" {
  name = "3mrai-local-spike-cluster"

  tags = { Name = "3mrai-local-spike-cluster" }
}

resource "aws_cloudwatch_log_group" "spike" {
  name              = "/ecs/3mrai-local-spike"
  retention_in_days = 1
}

resource "aws_ecs_task_definition" "spike_nginx" {
  family                   = "3mrai-local-spike-nginx"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.spike_ecs_execution.arn

  container_definitions = jsonencode([{
    name      = "nginx"
    image     = "nginx:alpine"
    essential = true

    portMappings = [{
      containerPort = 80
      hostPort      = 80
      protocol      = "tcp"
    }]

    # Shell entrypoint writes nginx config then starts nginx.
    # proxy_pass resolves spike-backend by Docker DNS on 3mrai_3mrai-network.
    # resolver 127.0.0.11 is Docker's embedded DNS server.
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
  name            = "3mrai-local-spike-nginx"
  cluster         = aws_ecs_cluster.spike.id
  task_definition = aws_ecs_task_definition.spike_nginx.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [aws_subnet.spike_a.id, aws_subnet.spike_b.id]
    security_groups  = [aws_security_group.spike.id]
    assign_public_ip = true
  }
}

# ------------------------------------------------------------
# API Gateway v2 (HTTP) + JWT authorizer
#
# Integration URI: initially a placeholder (http://0.0.0.0:80/).
# The smoke test discovers the Nginx container IP after ECS task launch
# and updates the integration via:
#   aws apigatewayv2 update-integration --integration-uri http://<nginx-ip>:80/
#
# In production this is a stable ALB DNS name. The IP-based approach is a
# Ministack-only pattern caused by the absence of a working ALB forwarder.
# ------------------------------------------------------------
resource "aws_apigatewayv2_api" "spike" {
  name          = "3mrai-local-spike-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_authorizer" "spike" {
  api_id           = aws_apigatewayv2_api.spike.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "3mrai-local-spike-jwt"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.spike.id]
    # Ministack issues IdTokens with the standard AWS Cognito issuer URL,
    # not the localhost endpoint. The authorizer must match the iss claim exactly.
    issuer = "https://cognito-idp.us-east-1.amazonaws.com/${aws_cognito_user_pool.spike.id}"
  }
}

resource "aws_apigatewayv2_integration" "spike_nginx" {
  api_id             = aws_apigatewayv2_api.spike.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  connection_type    = "INTERNET"

  # Placeholder — updated by smoke-test.sh after the Nginx ECS container
  # IP is discovered via `docker inspect ministack-ecs-*-nginx`.
  integration_uri = "http://${var.nginx_integration_placeholder}/"
}

# Protected route — requires valid Cognito JWT
resource "aws_apigatewayv2_route" "spike_protected" {
  api_id             = aws_apigatewayv2_api.spike.id
  route_key          = "GET /protected"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.spike.id
  target             = "integrations/${aws_apigatewayv2_integration.spike_nginx.id}"
}

# Public route — no auth, baseline connectivity check
resource "aws_apigatewayv2_route" "spike_public" {
  api_id             = aws_apigatewayv2_api.spike.id
  route_key          = "GET /public"
  authorization_type = "NONE"
  target             = "integrations/${aws_apigatewayv2_integration.spike_nginx.id}"
}

# Default auto-deploy stage
resource "aws_apigatewayv2_stage" "spike" {
  api_id      = aws_apigatewayv2_api.spike.id
  name        = "$default"
  auto_deploy = true
}
