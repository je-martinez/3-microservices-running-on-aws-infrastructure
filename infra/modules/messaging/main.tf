# ─── Dead Letter Queue ─────────────────────────────────────────────────────────
# Declared first: the main queue's RedrivePolicy references its ARN.
resource "aws_sqs_queue" "dlq" {
  name                      = "${var.context.id}-dlq"
  message_retention_seconds = 1209600 # 14 days — DLQ messages need longer to triage

  tags = merge(var.context.tags, { Name = "${var.context.id}-dlq" })
}

# ─── Main Queue ─────────────────────────────────────────────────────────────────
resource "aws_sqs_queue" "main" {
  name                       = "${var.context.id}-events"
  visibility_timeout_seconds = var.visibility_timeout_seconds
  message_retention_seconds  = var.message_retention_seconds

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = merge(var.context.tags, { Name = "${var.context.id}-events" })
}

# ─── DLQ redrive permission ─────────────────────────────────────────────────────
# Ties the DLQ back to the main queue so AWS (and Floci, verified per
# docs/lessons/floci-sqs-lambda-docdb-support.md) accepts the RedrivePolicy.
resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.main.arn]
  })
}
