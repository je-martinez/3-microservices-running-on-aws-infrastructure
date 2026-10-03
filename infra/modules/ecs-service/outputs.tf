output "service_name" { value = aws_ecs_service.this.name }
output "task_family" { value = local.family }
output "target_group_arns" {
  value = { for k, tg in aws_lb_target_group.this : k => tg.arn }
}
