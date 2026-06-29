output "id" {
  description = "Composed resource identifier, e.g. 3mrai-local-users."
  value       = module.this.id
}

output "tags" {
  description = "Merged tag map to apply to all resources in the calling module."
  value       = module.this.tags
}
