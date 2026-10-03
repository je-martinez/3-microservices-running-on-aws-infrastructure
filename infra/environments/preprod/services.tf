module "label_ecs" {
  source      = "../../modules/label"
  environment = var.environment
  name        = "ecs"
}

resource "aws_ecs_cluster" "this" {
  name = "${module.label_ecs.id}-cluster"
}

resource "aws_iam_role" "ecs_execution" {
  name = "${module.label_ecs.id}-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ecs-tasks.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

module "alb" {
  source             = "../../modules/alb"
  context            = { id = module.label_ecs.id, tags = module.label_ecs.tags }
  subnet_ids         = module.networking.subnet_ids
  security_group_ids = module.networking.security_group_ids
  vpc_id             = module.networking.vpc_id
}

locals {
  pg_port    = data.aws_rds_cluster.pg.port
  mysql_port = data.aws_rds_cluster.mysql.port

  aws_common = {
    AWS_ENDPOINT_URL      = "http://floci:4566"
    AWS_REGION            = local.region
    AWS_ACCESS_KEY_ID     = "test"
    AWS_SECRET_ACCESS_KEY = "test"
  }
  otel_common = {
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://floci:4318"
    OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
    OTEL_METRICS_EXPORTER       = "none"
    OTEL_LOGS_EXPORTER          = "none"
  }
  users_grpc_url = var.users_grpc_via_alb ? "http://floci:9151" : "http://users-grpc:50051"

  parameters = {
    users = merge(local.aws_common, local.otel_common, {
      COGNITO_USER_POOL_ID    = module.cognito.user_pool_id
      COGNITO_CLIENT_ID       = module.cognito.client_id
      ORDERS_BASE_URL         = "http://floci:9102"
      TRACKING_BASE_URL       = "http://floci:9103"
      EVENTS_TOPIC_ARN        = module.messaging.topic_arn
      NOTIFICATIONS_QUEUE_URL = module.messaging.notifications_queue_url
      WS_MANAGEMENT_ENDPOINT  = module.api_gateway_ws.management_endpoint_local
      WS_CONNECTIONS_TABLE    = module.ws_connections.table_name
      WS_CONNECTIONS_GSI      = module.ws_connections.gsi_name
      REDIS_HOST              = module.redis.redis_host
      REDIS_PORT              = tostring(module.redis.redis_port)
      PORT                    = "3000"
      GRPC_PORT               = "50051"
      E2E_TESTING_ENABLED     = "true"
      CACHE_ENABLED           = "true"
      STRIPE_ENABLED          = "false"
      DEPLOYMENT_ENVIRONMENT  = "preprod"
      METRICS_INTERVAL_MS     = "60000"
    })
    orders = merge(local.aws_common, {
      OTEL_EXPORTER_OTLP_ENDPOINT = "http://floci:4318"
      OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
      OTEL_DIAGNOSTICS__LOGLEVEL  = "Error"
      USERS_GRPC_URL              = local.users_grpc_url
      TRACKING_BASE_URL           = "http://floci:9103"
      REDIS_HOST                  = module.redis.redis_host
      REDIS_PORT                  = tostring(module.redis.redis_port)
      EVENTS_TOPIC_ARN            = module.messaging.topic_arn
      ASSETS_BASE_URL             = module.assets_bucket.public_base_url
      CACHE_ENABLED               = "true"
      STRIPE_ENABLED              = "false"
      SEED_ON_STARTUP             = "true"
      E2E_TESTING_ENABLED         = "true"
      DEPLOYMENT_ENVIRONMENT      = "preprod"
      METRICS_INTERVAL_MS         = "60000"
    })
    tracking = merge(local.aws_common, local.otel_common, {
      USERS_GRPC_URL               = local.users_grpc_url
      ORDERS_BASE_URL              = "http://floci:9102"
      EVENTS_TOPIC_ARN             = module.messaging.topic_arn
      REDIS_HOST                   = module.redis.redis_host
      REDIS_PORT                   = tostring(module.redis.redis_port)
      PORT                         = "8000"
      ENVIRONMENT                  = "development"
      E2E_TESTING_ENABLED          = "true"
      CACHE_ENABLED                = "true"
      METRICS_ENABLED              = "true"
      METRICS_INTERVAL_SECONDS     = "60"
      PROGRESSION_INTERVAL_SECONDS = "5"
      DEPLOYMENT_ENVIRONMENT       = "preprod"
    })
  }

  secrets = {
    users = {
      DATABASE_WRITER_URL = "postgres://${var.db_username}:${var.db_password}@floci:${local.pg_port}/users"
      DATABASE_READER_URL = "postgres://${var.db_username}:${var.db_password}@floci:${local.pg_port}/users"
      WEBHOOK_SECRET      = random_password.webhook_secret.result
      INTERNAL_API_KEY    = random_password.internal_api_key.result
    }
    orders = {
      DATABASE_WRITER_URL = "Server=floci;Port=${local.mysql_port};Database=orders;User=${var.db_username};Password=${var.db_password};SslMode=None;"
      DATABASE_READER_URL = "Server=floci;Port=${local.mysql_port};Database=orders;User=${var.db_username};Password=${var.db_password};SslMode=None;"
      INTERNAL_API_KEY    = random_password.internal_api_key.result
    }
    tracking = {
      DATABASE_WRITER_URL      = "mysql+pymysql://${var.db_username}:${var.db_password}@floci:${local.mysql_port}/tracking?charset=utf8mb4"
      DATABASE_READER_URL      = "mysql+pymysql://${var.db_username}:${var.db_password}@floci:${local.mysql_port}/tracking?charset=utf8mb4"
      INTERNAL_API_KEY         = random_password.internal_api_key.result
      TRACKING_CARRIER_API_KEY = random_password.carrier_api_key.result
    }
  }

  services = {
    users = {
      port = 3000, cpu = 512, memory = 1024, extra_ports = [50051]
      listeners = merge(
        { http = { port = 9101, container_port = 3000, health_path = "/v1/health" } },
        var.users_grpc_via_alb ? { grpc = { port = 9151, container_port = 50051, protocol_version = "GRPC", health_path = "/" } } : {},
      )
    }
    orders = {
      port      = 8080, cpu = 512, memory = 1024, extra_ports = []
      listeners = { http = { port = 9102, container_port = 8080, health_path = "/v1/health" } }
    }
    tracking = {
      port      = 8000, cpu = 256, memory = 512, extra_ports = []
      listeners = { http = { port = 9103, container_port = 8000, health_path = "/v1/health" } }
    }
  }
}

module "app_config" {
  source     = "../../modules/app-config"
  prefix     = "3mrai-${var.environment}"
  parameters = local.parameters
  secrets    = local.secrets
}

module "service" {
  source   = "../../modules/ecs-service"
  for_each = var.deploy_services ? local.services : {}

  context            = { id = module.label_ecs.id, tags = module.label_ecs.tags }
  name               = each.key
  cluster_arn        = aws_ecs_cluster.this.arn
  execution_role_arn = aws_iam_role.ecs_execution.arn
  image              = "${module.ecr.repository_urls[each.key]}:${var.image_tags[each.key]}"
  cpu                = each.value.cpu
  memory             = each.value.memory
  container_port     = each.value.port
  extra_ports        = each.value.extra_ports
  secrets            = module.app_config.refs[each.key]
  listeners          = each.value.listeners
  alb_arn            = module.alb.arn
  vpc_id             = module.networking.vpc_id
  subnet_ids         = module.networking.subnet_ids
  security_group_ids = module.networking.security_group_ids
  region             = local.region
}

module "api_gateway" {
  source                   = "../../modules/api-gateway"
  context                  = { id = module.label_api.id, tags = module.label_api.tags }
  cognito_issuer           = module.cognito.issuer
  cognito_audience         = module.cognito.client_id
  local_gateway            = true
  enable_e2e_cleanup_route = true
  enable_tracking_routes   = true
  alb_backends = {
    users    = "http://localhost:9101"
    orders   = "http://localhost:9102"
    tracking = "http://localhost:9103"
  }
}
