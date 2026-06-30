output "cognito_user_pool_id" {
  description = "Cognito User Pool ID used by the JWT authorizer."
  value       = aws_cognito_user_pool.spike.id
}

output "cognito_client_id" {
  description = "Cognito App Client ID (JWT audience)."
  value       = aws_cognito_user_pool_client.spike.id
}

output "jwt_issuer" {
  description = "Issuer URL on the JWT authorizer. Floci issues IdTokens with iss=http://localhost:4566/<pool-id> (its own endpoint), unlike Ministack's AWS-domain issuer."
  value       = "http://localhost:4566/${aws_cognito_user_pool.spike.id}"
}

output "ecs_cluster_name" {
  description = "ECS cluster name (used by smoke-test.sh to locate the Nginx container)."
  value       = aws_ecs_cluster.spike.name
}

output "api_id" {
  description = "API Gateway v2 API ID. Local invoke URL: http://<api_id>.execute-api.localhost:4566"
  value       = aws_apigatewayv2_api.spike.id
}

output "nginx_integration_id" {
  description = "API GW integration ID; smoke-test.sh patches its URI if Cloud Map DNS is not resolvable by Floci's API GW."
  value       = aws_apigatewayv2_integration.spike_nginx.id
}

output "cloudmap_service_name" {
  description = "Cloud Map DNS name targeted by the integration (nginx.spike.local)."
  value       = "nginx.spike.local"
}
