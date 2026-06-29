output "api_invoke_url" {
  description = "API Gateway invoke URL (base URL for the spike HTTP API). NOTE: this AWS domain is not resolvable locally; smoke-test.sh derives http://<api-id>.execute-api.localhost:4566 instead."
  value       = aws_apigatewayv2_stage.spike.invoke_url
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID used by the JWT authorizer."
  value       = aws_cognito_user_pool.spike.id
}

output "cognito_client_id" {
  description = "Cognito App Client ID (JWT audience)."
  value       = aws_cognito_user_pool_client.spike.id
}

output "jwt_issuer" {
  description = "Issuer URL configured on the JWT authorizer (matches the iss claim Ministack puts in IdTokens)."
  value       = "https://cognito-idp.us-east-1.amazonaws.com/${aws_cognito_user_pool.spike.id}"
}

output "nginx_integration_id" {
  description = "API Gateway integration ID for the Nginx ECS task. Used by smoke-test.sh to update the integration URI to the actual Nginx container IP after ECS task launch."
  value       = aws_apigatewayv2_integration.spike_nginx.id
}

output "ecs_cluster_name" {
  description = "ECS cluster name (used by smoke-test.sh to identify the Nginx container via docker inspect)."
  value       = aws_ecs_cluster.spike.name
}
