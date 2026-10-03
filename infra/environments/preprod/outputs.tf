output "vpc_id" { value = module.networking.vpc_id }
output "subnet_ids" { value = module.networking.subnet_ids }
output "security_group_ids" { value = module.networking.security_group_ids }
output "cognito_user_pool_id" { value = module.cognito.user_pool_id }
output "cognito_client_id" { value = module.cognito.client_id }
output "cognito_issuer" { value = module.cognito.issuer }
output "pg_port" { value = data.aws_rds_cluster.pg.port }
output "mysql_port" { value = data.aws_rds_cluster.mysql.port }
output "redis_host" { value = module.redis.redis_host }
output "redis_port" { value = module.redis.redis_port }
output "events_topic_arn" { value = module.messaging.topic_arn }
output "notifications_queue_url" { value = module.messaging.notifications_queue_url }
output "events_query_url" { value = module.lambda_events_pipeline.function_url }
output "ws_url" { value = module.api_gateway_ws.ws_url_local }
output "ws_management_endpoint" { value = module.api_gateway_ws.management_endpoint_local }
output "ws_connections_table" { value = module.ws_connections.table_name }
output "ws_connections_gsi" { value = module.ws_connections.gsi_name }
output "assets_base_url" { value = module.assets_bucket.public_base_url }
output "docdb_host" { value = "floci-docdb-${module.docdb.cluster_identifier}" }
output "internal_api_key" {
  value     = random_password.internal_api_key.result
  sensitive = true
}
output "carrier_api_key" {
  value     = random_password.carrier_api_key.result
  sensitive = true
}
output "e2e_query_token" {
  value     = random_password.e2e_query_token.result
  sensitive = true
}
output "openobserve_root_password" {
  value     = random_password.openobserve_root.result
  sensitive = true
}
