variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "max_receive_count" {
  description = "Number of deliveries before a message moves to the DLQ."
  type        = number
  default     = 3
}

variable "visibility_timeout_seconds" {
  description = <<-EOT
    SQS visibility timeout for the main queue. MUST stay at least 6x the
    consuming Lambda's timeout (AWS's own guidance for an SQS event source
    mapping): 180 = 6 x the lambda module's 30s default.

    Setting these equal is the trap. A batch that runs the full function
    timeout has its visibility expire at the very moment the function ends, so
    SQS redelivers records the Lambda is still finishing. Local testing cannot
    surface this — batches arrive size-1 and complete in milliseconds — so it
    would first appear in production as a steady trickle of duplicate
    deliveries. The unique index on event_id absorbs most of it, but the window
    between insertStarted and the COMPLETED transition is not idempotent, so a
    concurrent redelivery can reach sendEmail before the first invocation
    finishes and mail the user twice.
  EOT
  type        = number
  default     = 180
}

variable "message_retention_seconds" {
  description = "How long SQS retains an undelivered message (main queue)."
  type        = number
  default     = 345600 # 4 days
}

variable "notification_event_types" {
  description = <<-EOT
    Event types the notifications subscription accepts, matched on the `type`
    message attribute. Exactly the three that produce a notification: a WELCOME row
    from USER_CREATED, the ORDER_STATUS/PLACED row from ORDER_CREATED, and the four
    transition ORDER_STATUS rows from TRACKING_STATUS_CHANGED.

    ORDER_CREATED is admitted because it is the "order placed" trigger: PLACED is
    the status a tracking row is CREATED in, never a transition, so it is never
    emitted as a TRACKING_STATUS_CHANGED and a tracking-only policy would deliver
    no order-placed notification at all.

    AUTH_OTP_REQUESTED and PASSWORD_RESET_REQUESTED produce no notification and
    stay out. Adding a type here plus a copy variant is all a future change needs
    — the `type` column is a plain string, not a constrained enum.
  EOT
  type        = list(string)
  default     = ["USER_CREATED", "ORDER_CREATED", "TRACKING_STATUS_CHANGED"]
}

variable "notifications_visibility_timeout_seconds" {
  description = <<-EOT
    Visibility timeout for the notifications queue. Lower than the events queue's
    180 because its consumer is an in-process handler doing one INSERT and one
    best-effort WebSocket push, not a Lambda with a 30s timeout to multiply out.

    60 leaves ample headroom over the handler's real cost while keeping redelivery
    of a genuinely stuck message within a minute. The duplicate that redelivery
    produces is an ACCEPTED outcome here: there is no idempotency key, by
    decision. See [[2026-09-10-in-app-notifications-design]]
  EOT
  type        = number
  default     = 60
}
