output "api_id" {
  description = "ID of the HTTP API Gateway. Used by the JE-36 bootstrap to patch the nginx integration URI."
  value       = aws_apigatewayv2_api.this.id
}

output "invoke_url" {
  description = <<-EOT
    Invoke URL of the $default stage.
    In Ministack the URL takes the form:
      http://<api-id>.execute-api.localhost:4566
    (Ministack returns https:// in the stage resource but the actual reachable
    form from the host machine uses http:// on port 4566.)
  EOT
  value       = aws_apigatewayv2_stage.default.invoke_url
}
