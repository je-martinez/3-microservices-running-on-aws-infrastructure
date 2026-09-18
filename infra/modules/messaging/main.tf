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

# ─── SNS fan-out topic ──────────────────────────────────────────────────────────
# The single publish target for all three producers. SQS is point-to-point — each
# message reaches exactly ONE of two competing consumers — so a second consumer on
# the events queue would make emails and notifications each go missing at random.
# See [[2026-09-10-in-app-notifications-design]]
resource "aws_sns_topic" "events" {
  name = "${var.context.id}-events-topic"

  tags = merge(var.context.tags, { Name = "${var.context.id}-events-topic" })
}

# ─── Notifications queue (the Users consumer's own) ─────────────────────────────
# Its own DLQ target is the SHARED dlq: a poison message is a poison message
# whichever consumer choked on it, and a second DLQ doubles the places to triage.
resource "aws_sqs_queue" "notifications" {
  name                       = "${var.context.id}-notifications"
  visibility_timeout_seconds = var.notifications_visibility_timeout_seconds
  message_retention_seconds  = var.message_retention_seconds

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = merge(var.context.tags, { Name = "${var.context.id}-notifications" })
}

# ─── Subscriptions ──────────────────────────────────────────────────────────────
# CONTRACT: raw_message_delivery = true on BOTH subscriptions. Without it SNS wraps
# the body in its own JSON envelope, and the events-pipeline's EnvelopeSchema then
# receives an SNS envelope instead of the domain envelope — every existing handler
# breaks silently. With raw delivery the body is byte-for-byte what the producers
# publish today and the pipeline changes not one line.
# See [[2026-09-10-in-app-notifications-design]]
resource "aws_sns_topic_subscription" "events_queue" {
  topic_arn            = aws_sns_topic.events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.main.arn
  raw_message_delivery = true
}

# CONTRACT: The filter is on the `type` MESSAGE ATTRIBUTE, not the body — under raw
# delivery the body is opaque to SNS. AUTH_OTP_REQUESTED and PASSWORD_RESET_REQUESTED
# produce no notification and must not arrive at all. The consumer ALSO discards
# unknown types in code, as defence in depth.
resource "aws_sns_topic_subscription" "notifications_queue" {
  topic_arn            = aws_sns_topic.events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.notifications.arn
  raw_message_delivery = true

  filter_policy_scope = "MessageAttributes"
  filter_policy       = jsonencode({ type = var.notification_event_types })
}

# ─── Queue policies ─────────────────────────────────────────────────────────────
# CONTRACT: Both queues need one. SNS delivery into a queue with no policy naming
# the topic is DROPPED, with no error at the publisher and no message at the
# consumer — the publish reports success either way.
resource "aws_sqs_queue_policy" "main_from_sns" {
  queue_url = aws_sqs_queue.main.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSnsDelivery"
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.main.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.events.arn } }
    }]
  })
}

resource "aws_sqs_queue_policy" "notifications_from_sns" {
  queue_url = aws_sqs_queue.notifications.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSnsDelivery"
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.notifications.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.events.arn } }
    }]
  })
}
