locals {
  table_name = "${var.context.id}-ws-connections"
}

# Connection registry for the WebSocket API. Written by the $connect and
# $disconnect handlers; read (and pruned on 410 Gone) by the events-pipeline.
#
# The GSI hash key is `cognito_sub`, NOT `user_id`, and the name says so
# deliberately: the event envelope's `user_id` is the internal usr_ id, and
# querying this index with it would return zero rows with no error at all.
# See docs/superpowers/specs/2026-08-05-realtime-tracking-events-websocket-design.md
# and the user-id-vs-cognito-sub-ownership-key ADR.
resource "aws_dynamodb_table" "connections" {
  name         = local.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "connection_id"

  attribute {
    name = "connection_id"
    type = "S"
  }

  attribute {
    name = "cognito_sub"
    type = "S"
  }

  global_secondary_index {
    name            = "by-cognito-sub"
    hash_key        = "cognito_sub"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = var.ttl_attribute
    enabled        = true
  }

  tags = merge(var.context.tags, { Name = local.table_name })
}
