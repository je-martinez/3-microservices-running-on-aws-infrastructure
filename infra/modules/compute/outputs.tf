output "cluster_name" {
  description = "Name of the ECS cluster."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ARN of the ECS cluster."
  value       = aws_ecs_cluster.this.arn
}

output "service_name" {
  description = "Name of the ECS service running the nginx reverse proxy."
  value       = aws_ecs_service.nginx.name
}

output "task_definition_family" {
  description = "Family name of the nginx task definition. Used by the JE-36 bootstrap to look up the running task's private IP."
  value       = aws_ecs_task_definition.nginx.family
}

output "log_group_name" {
  description = "CloudWatch log group name for nginx container logs."
  value       = aws_cloudwatch_log_group.nginx.name
}
