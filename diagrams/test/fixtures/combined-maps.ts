// CONTRACT: the full node set ([id, icon]) and edge set ([id, from, to]) of each architecture map that is
// drawn as two views, keyed by the request-path entry id; its events view is `<id>-events`. The union of
// the two views must contain every one of them (test/split-views.test.ts). Change a map here and in its
// views together.
export const combinedMaps: Record<string, { nodes: [string, string][]; edges: [string, string, string][] }> = {
  "architecture-dev-floci": {
    nodes: [
      ["browser", "client"], ["web", "server"], ["eb", "eventbridge"], ["orders", "server"], ["ses", "ses"], ["nginx", "ecs-task"],
      ["dlq", "sqs"], ["cognito", "cognito"], ["dynamodb", "dynamodb"], ["tracking", "server"], ["sm", "secrets-manager"], ["s3", "s3"],
      ["users", "server"], ["sqs", "sqs"], ["docdb", "documentdb"], ["otel", "server"], ["redis", "elasticache"], ["rds", "rds"],
      ["apigw", "api-gateway"], ["ws", "api-gateway"], ["ws-fns", "lambda"], ["cw", "cloudwatch"], ["cognito-fns", "lambda"], ["sns", "sns"],
      ["lambda", "lambda"],
    ],
    edges: [
      ["ws-fns", "ws", "ws-fns"], ["users-realtime", "users", "realtime"], ["sqs-dlq", "sqs", "dlq"],
      ["sns-sqs", "sns", "sqs"], ["nginx-compose", "nginx", "compose"], ["browser-s3", "browser", "s3"],
      ["sqs-users", "sqs", "users"], ["browser-web", "browser", "web"], ["nginx-cw", "nginx", "cw"],
      ["browser-ws", "browser", "ws"], ["lambda-ses", "lambda", "ses"], ["compose-rds", "compose", "rds"],
      ["lambda-cw", "lambda", "cw"], ["cognito-fns", "cognito", "cognito-fns"], ["compose-cw", "compose", "cw"],
      ["users-cognito", "users", "cognito"], ["lambda-realtime", "lambda", "realtime"], ["ws-fns-dynamodb", "ws-fns", "dynamodb"],
      ["fns-sqs", "cognito-fns", "sqs"], ["compose-otel", "compose", "otel"], ["sqs-lambda", "sqs", "lambda"],
      ["fns-cw", "cognito-fns", "cw"], ["compose-redis", "compose", "redis"], ["lambda-docdb", "lambda", "docdb"],
      ["apigw-nginx", "apigw", "nginx"], ["ws-fns-cw", "ws-fns", "cw"], ["web-apigw", "web", "apigw"],
      ["tracking-users", "tracking", "users"], ["orders-users", "orders", "users"], ["eb-lambda", "eb", "lambda"],
      ["web-otel", "web", "otel"], ["lambda-otel", "lambda", "otel"], ["cw-otel", "cw", "otel"],
      ["compose-sns", "compose", "sns"], ["ws-fns-otel", "ws-fns", "otel"], ["apigw-cognito", "apigw", "cognito"],
    ],
  },
  "architecture-preprod": {
    nodes: [
      ["browser", "client"], ["apigw", "api-gateway"], ["ws", "api-gateway"], ["s3", "s3"], ["sns", "sns"], ["docdb", "documentdb"],
      ["mailpit", "ecs-task"], ["web", "ecs-task"], ["redis", "elasticache"], ["lambda", "lambda"], ["cw", "cloudwatch"], ["alb", "alb"],
      ["dynamodb", "dynamodb"], ["sqs", "sqs"], ["orders", "ecs-task"], ["eb", "eventbridge"], ["o2", "ecs-task"], ["tracking", "ecs-task"],
      ["users", "ecs-task"], ["cognito", "cognito"], ["rds", "rds"], ["ws-fns", "lambda"], ["ecr", "ecr"], ["config", "ssm"],
      ["cognito-fns", "lambda"], ["dlq", "sqs"], ["otel", "ecs-task"], ["ses", "ses"],
    ],
    edges: [
      ["browser-alb", "browser", "alb"], ["lambda-ses", "lambda", "ses"], ["ecr-cluster", "ecr", "cluster"],
      ["users-realtime", "users", "realtime"], ["orders-users", "orders", "users"], ["eb-lambda", "eb", "lambda"],
      ["users-cognito", "users", "cognito"], ["tracking-users", "tracking", "users"], ["config-cluster", "config", "cluster"],
      ["lambda-docdb", "lambda", "docdb"], ["ws-fns", "ws", "ws-fns"], ["alb-cluster", "alb", "cluster"],
      ["otel-o2", "otel", "o2"], ["sqs-dlq", "sqs", "dlq"], ["backend-otel", "backend", "otel"],
      ["browser-s3", "browser", "s3"], ["cognito-fns", "cognito", "cognito-fns"], ["fns-sqs", "cognito-fns", "sqs"],
      ["browser-ws", "browser", "ws"], ["sqs-lambda", "sqs", "lambda"], ["cluster-cw", "cluster", "cw"],
      ["sns-sqs", "sns", "sqs"], ["apigw-cognito", "apigw", "cognito"], ["backend-sns", "backend", "sns"],
      ["backend-rds", "backend", "rds"], ["browser-apigw", "browser", "apigw"], ["cw-otel", "cw", "otel"],
      ["apigw-alb", "apigw", "alb"], ["sqs-users", "sqs", "users"], ["ws-fns-dynamodb", "ws-fns", "dynamodb"],
      ["ses-mailpit", "ses", "mailpit"], ["backend-redis", "backend", "redis"], ["lambda-realtime", "lambda", "realtime"],
      ["fns-cw", "fns", "cw"], ["lambda-otel", "lambda", "otel"], ["ws-fns-otel", "ws-fns", "otel"],
      ["web-otel", "web", "otel"],
    ],
  },
  "system-context-l2": {
    nodes: [
      ["customer", "users"], ["apigw", "api-gateway"], ["dynamodb", "dynamodb"], ["dlq", "sqs"], ["web", "ecs-task"], ["sns", "sns"],
      ["o2", "ecs-task"], ["ws", "api-gateway"], ["cognito", "cognito"], ["s3", "s3"], ["orders", "ecs-task"], ["redis", "elasticache"],
      ["tracking", "ecs-task"], ["docdb", "documentdb"], ["sqs", "sqs"], ["alb", "alb"], ["ws-fns", "lambda"], ["otel", "ecs-task"],
      ["lambda", "lambda"], ["cw", "cloudwatch"], ["ses", "ses"], ["cognito-fns", "lambda"], ["pg", "rds"], ["config", "ssm"],
      ["ecr", "ecr"], ["eb", "eventbridge"], ["mailpit", "ecs-task"], ["users", "ecs-task"], ["mysql", "rds"],
    ],
    edges: [
      ["users-cognito", "users", "cognito"], ["ws-fns-dynamodb", "ws-fns", "dynamodb"], ["users-pg", "users", "pg"],
      ["fns-cw", "fns", "cw"], ["customer-alb", "customer", "alb"], ["lambda-ses", "lambda", "ses"],
      ["config-cluster", "config", "cluster"], ["sqs-lambda", "sqs", "lambda"], ["lambda-realtime", "lambda", "realtime"],
      ["web-otel", "web", "otel"], ["tracking-users", "tracking", "users"], ["orders-mysql", "orders", "mysql"],
      ["customer-ws", "customer", "ws"], ["otel-o2", "otel", "o2"], ["services-redis", "services", "redis"],
      ["users-realtime", "users", "realtime"], ["apigw-cognito", "apigw", "cognito"], ["alb-cluster", "alb", "cluster"],
      ["ses-mailpit", "ses", "mailpit"], ["services-sns", "services", "sns"], ["lambda-docdb", "lambda", "docdb"],
      ["ws-fns-otel", "ws-fns", "otel"], ["sns-sqs", "sns", "sqs"], ["cluster-cw", "cluster", "cw"],
      ["customer-s3", "customer", "s3"], ["apigw-alb", "apigw", "alb"], ["ws-fns", "ws", "ws-fns"],
      ["lambda-otel", "lambda", "otel"], ["cognito-fns", "cognito", "cognito-fns"], ["sqs-dlq", "sqs", "dlq"],
      ["fns-sqs", "cognito-fns", "sqs"], ["sqs-users", "sqs", "users"], ["tracking-mysql", "tracking", "mysql"],
      ["cw-otel", "cw", "otel"], ["eb-lambda", "eb", "lambda"], ["services-otel", "services", "otel"],
      ["customer-apigw", "customer", "apigw"], ["orders-users", "orders", "users"], ["ecr-cluster", "ecr", "cluster"],
    ],
  },
};
