output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.this.id
}

output "subnet_ids" {
  description = "List of subnet IDs created by the module."
  value       = [for s in aws_subnet.this : s.id]
}

output "security_group_ids" {
  description = "List containing the ID of the default security group."
  value       = [aws_security_group.this.id]
}
