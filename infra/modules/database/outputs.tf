output "cluster_identifier" {
  description = "DocumentDB cluster identifier — used to derive the Floci backing container name floci-docdb-<cluster_identifier> (see docs/lessons/floci-sqs-lambda-docdb-support.md)."
  value       = aws_docdb_cluster.this.cluster_identifier
}

output "endpoint" {
  description = "DocumentDB cluster endpoint (not host-reachable locally — see the lesson above; use the container name instead)."
  value       = aws_docdb_cluster.this.endpoint
}

output "port" {
  description = "DocumentDB port."
  value       = aws_docdb_cluster.this.port
}

output "master_username" {
  description = "DocumentDB master username."
  value       = var.master_username
}
