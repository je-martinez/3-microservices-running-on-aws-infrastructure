output "api_id" {
  description = "WebSocket API id."
  value       = aws_apigatewayv2_api.this.id
}

output "stage_name" {
  description = "WebSocket API stage name."
  value       = aws_apigatewayv2_stage.this.name
}

# Floci serves the data plane at /ws/{apiId}/{stage} — NOT the
# restapis/<id>/$default/_user_request_/ shape the HTTP API uses. Verified by
# POC on 2026-08-05.
output "ws_url_local" {
  description = "Local (Floci) WebSocket URL clients connect to."
  value       = "ws://localhost:4566/ws/${aws_apigatewayv2_api.this.id}/${aws_apigatewayv2_stage.this.name}"
}

# The @connections management endpoint on Floci carries an UNDOCUMENTED
# /execute-api/ prefix and differs from real AWS
# (https://{apiId}.execute-api.{region}.amazonaws.com/{stage}). Wrong shapes
# return HTTP 400 with an S3 XML body, because unrouted :4566 paths fall
# through to Floci's S3 handler. Verified by POC on 2026-08-05.
output "management_endpoint_local" {
  description = "Local (Floci) @connections management endpoint for the events-pipeline."
  value       = "http://floci:4566/execute-api/${aws_apigatewayv2_api.this.id}/${aws_apigatewayv2_stage.this.name}"
}
