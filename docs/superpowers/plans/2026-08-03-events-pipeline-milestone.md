---
title: Events Pipeline Milestone
type: plan
area: events-pipeline
status: draft
created: 2026-08-03
updated: 2026-08-03
tags: [type/plan, area/events-pipeline, status/draft]
propagates-to:
  - "[[events-pipeline-design]]"
  - "[[testing]]"
  - "[[env-files]]"
  - "[[tracking-service-design]]"
related:
  - "[[2026-08-03-events-pipeline-milestone-design]]"
  - "[[floci-sqs-lambda-docdb-support]]"
  - "[[testing]]"
  - "[[env-files]]"
  - "[[logging-context]]"
  - "[[nano-id]]"
  - "[[audit-fields]]"
  - "[[cqrs]]"
  - "[[tracking-service-design]]"
---

# Events Pipeline Milestone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the events-pipeline from design-only to a working SQS → Lambda → DocumentDB
pipeline that dispatches by event `type`, sends real email via SES/react-email, and is fed by
real publishers in Users, Orders, and Tracking — so that `POST /v1/users/register` ends up as a
`COMPLETED` document in DocumentDB and an email in Mailpit, and a tracking delivery-status
change ends up as a document in DocumentDB and a notification email in Mailpit.

**Architecture:** One shared SQS queue (+ DLQ) feeds a single Lambda with an
`aws_lambda_event_source_mapping` (`ReportBatchItemFailures`). The Lambda's state machine
(`process-record.ts`) is AWS-SDK-free and persists an event document (STARTED → IN_PROGRESS →
COMPLETED/FAILED, append-only `status_history`) before dispatching by `type` to a handler that
validates the payload, renders a react-email template, and sends it via SES. Users, Orders, and
Tracking each publish to the shared queue: Users and Orders replace their `NoopEventPublisher`
with a real SQS publisher that generates `event_id`; Tracking — a third, new producer — emits
`TRACKING_STATUS_CHANGED` from its status-update command via a Python/boto3 publisher.

**Tech Stack:** Terraform (SQS, DocumentDB, Lambda modules), Node.js 24.18.0 (Lambda runtime),
TypeScript, Zod, MongoDB driver, `@aws-sdk/client-sqs`, `@aws-sdk/client-ses`, react-email,
vitest, nanoid, Floci (local AWS emulator), Mailpit (local SMTP inbox), Python/FastAPI + boto3
(Tracking's publisher, `pytest`).

## Global Constraints

- Node is pinned by `.nvmrc` (24.18.0) — run `nvm use` before ANY `node`/`npm`/`npx` command in
  this plan, including every vitest/terraform-adjacent script invocation.
- New scripts are **Python** for infra (per [[scripting-language]]); this plan's only new
  scripting is TypeScript inside `functions/events-pipeline/` (Node ecosystem), Terraform HCL,
  and Python inside `services/tracking/` (Task 14, the service's own existing stack) — no new
  `.sh` or ad-hoc infra scripts.
- Every env value comes from a generated env file (`make env-file` →
  `.env.local.events-pipeline`, plus updates to `.env.local.users`/`.env.local.orders`/
  `.env.local.tracking` for the new queue URL) per [[env-files]] — never hardcoded, never inline
  `environment:` in `docker-compose.yml`.
- Commits follow Conventional Commits with scope `events-pipeline`, `infra`, or `tracking` (per
  the module/service touched).
- The implementer writes ONLY source code (Terraform/TypeScript/`.tsx`/Python/compose/
  `CLAUDE.md` prose) and never runs git beyond the per-task commit shown in each step, and never
  touches Linear.
- TypeScript path aliases use `#` subpath imports (NOT `@`), mirroring Users
  (`#shared/*`, `#pipeline/*`, `#domain/*`, `#email/*`, `#handlers/*`).
- Tests use **vitest** (`npm test` → `vitest run`) for `functions/events-pipeline/` and Users;
  Task 14's Tracking-side tests use Tracking's own tooling, **pytest** (`pytest`, per
  `services/tracking/CLAUDE.md` §2) — do not port vitest conventions into that service.
- OTel config lives in env vars, never in code — no `options.endpoint`/`options.protocol` set
  in TypeScript; the Lambda's OTel setup (if added) follows [[logging-context]] and the
  env-vars-only rule already burned three services in this repo.

---

## Block A — Infrastructure

> **Dependency gate:** Block A must be fully applied (`terraform apply` succeeding, resources
> visible on Floci) before Block B's Lambda code can be verified end-to-end — Task 9's handler
> needs a real queue/table/function to invoke against. Tasks 1-3 can be written and
> `terraform validate`-clean in parallel, but the batch stops here for review per the phase-C
> review flow (see "Dependency gates" below).

### Task 1: `infra/modules/messaging/` — SQS queue + DLQ

**Files:**
- Create: `infra/modules/messaging/main.tf`
- Create: `infra/modules/messaging/variables.tf`
- Create: `infra/modules/messaging/outputs.tf`
- Create: `infra/modules/messaging/terraform.tf`
- Test: none (Terraform-only; verified via `terraform validate` + Floci `aws` CLI)

**Interfaces:**
- Consumes: `var.context` (`{ id: string, tags: map(string) }`, cloudposse label pattern per
  `infra/modules/rds-aurora/variables.tf`), `var.max_receive_count` (default `3`).
- Produces: `aws_sqs_queue.main` (referenced by Task 3's `aws_lambda_event_source_mapping` via
  `output "queue_arn"`), `aws_sqs_queue.dlq`, outputs `queue_url`, `queue_arn`, `dlq_url`,
  `dlq_arn`.

- [ ] **Step 1: Write the module**

`infra/modules/messaging/terraform.tf`:

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.31.0"
    }
  }
}
```

`infra/modules/messaging/variables.tf`:

```hcl
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
  description = "SQS visibility timeout for the main queue."
  type        = number
  default     = 30
}

variable "message_retention_seconds" {
  description = "How long SQS retains an undelivered message (main queue)."
  type        = number
  default     = 345600 # 4 days
}
```

`infra/modules/messaging/main.tf`:

```hcl
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
```

`infra/modules/messaging/outputs.tf`:

```hcl
output "queue_url" {
  description = "URL of the main events SQS queue (used by producers)."
  value       = aws_sqs_queue.main.id
}

output "queue_arn" {
  description = "ARN of the main events SQS queue (used by the Lambda event source mapping)."
  value       = aws_sqs_queue.main.arn
}

output "dlq_url" {
  description = "URL of the dead-letter queue."
  value       = aws_sqs_queue.dlq.id
}

output "dlq_arn" {
  description = "ARN of the dead-letter queue."
  value       = aws_sqs_queue.dlq.arn
}
```

- [ ] **Step 2: Validate**

```bash
cd infra/modules/messaging && terraform init -backend=false >/dev/null && terraform fmt -check && terraform validate
```

Expected: `terraform fmt -check` exits 0 (no output — already formatted); `terraform validate`
prints `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
git add infra/modules/messaging/
git commit -m "feat(infra): add messaging module for SQS events queue + DLQ"
```

---

### Task 2: `infra/modules/database/` — DocumentDB cluster + instance

**Files:**
- Create: `infra/modules/database/main.tf`
- Create: `infra/modules/database/variables.tf`
- Create: `infra/modules/database/outputs.tf`
- Create: `infra/modules/database/terraform.tf`
- Test: none (Terraform-only)

**Interfaces:**
- Consumes: `var.context`, `var.master_username` (default `"docdbadmin"`),
  `var.master_password` (sensitive, no default — mirrors `rds-aurora`'s pattern), `var.subnet_ids`,
  `var.security_group_ids`, `var.instance_class` (default `"db.t3.medium"`), `var.engine_version`
  (default `"5.0.0"` — matches the engine Floci reports per
  [[floci-sqs-lambda-docdb-support]]'s "engine reported as docdb 5.0.0" finding).
- Produces: `aws_docdb_cluster.this`, `aws_docdb_cluster_instance.this`, `aws_ssm_parameter`
  entries for host/port (per [[ADR-0007-secrets-parameter-store]]), outputs
  `cluster_identifier` (consumed by `main.tf` to build the `floci-docdb-<id>` container name per
  [[floci-sqs-lambda-docdb-support]]), `port`, `endpoint`.

- [ ] **Step 1: Write the module**

`infra/modules/database/terraform.tf`:

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.31.0"
    }
  }
}
```

`infra/modules/database/variables.tf`:

```hcl
variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "master_username" {
  description = "Master username for the DocumentDB cluster."
  type        = string
  default     = "docdbadmin"
}

variable "master_password" {
  description = "Master password for the DocumentDB cluster. Must be provided; do not set a default."
  type        = string
  sensitive   = true
}

variable "subnet_ids" {
  description = "List of subnet IDs for the DB subnet group."
  type        = list(string)
}

variable "security_group_ids" {
  description = "List of security group IDs to attach to the cluster."
  type        = list(string)
}

variable "instance_class" {
  description = "Instance class for the DocumentDB instance."
  type        = string
  default     = "db.t3.medium"
}

variable "engine_version" {
  description = "DocumentDB engine version. Floci's emulated cluster reports 5.0.0 regardless of what is requested (see docs/lessons/floci-sqs-lambda-docdb-support.md)."
  type        = string
  default     = "5.0.0"
}

variable "skip_final_snapshot" {
  description = "Whether to skip the final snapshot on cluster deletion."
  type        = bool
  default     = true
}
```

`infra/modules/database/main.tf`:

```hcl
# ─── DocumentDB Subnet Group ────────────────────────────────────────────────────
resource "aws_docdb_subnet_group" "this" {
  name       = "${var.context.id}-docdb-subnet-group"
  subnet_ids = var.subnet_ids

  tags = merge(var.context.tags, { Name = "${var.context.id}-docdb-subnet-group" })
}

# ─── DocumentDB Cluster ──────────────────────────────────────────────────────────
resource "aws_docdb_cluster" "this" {
  cluster_identifier      = "${var.context.id}-docdb"
  engine                  = "docdb"
  engine_version           = var.engine_version
  master_username         = var.master_username
  master_password         = var.master_password
  db_subnet_group_name    = aws_docdb_subnet_group.this.name
  vpc_security_group_ids  = var.security_group_ids
  skip_final_snapshot     = var.skip_final_snapshot

  tags = merge(var.context.tags, { Name = "${var.context.id}-docdb" })
}

# ─── DocumentDB Instance ─────────────────────────────────────────────────────────
# Floci backs this with a single standalone mongo:7.0 container (no replica set —
# see docs/lessons/floci-sqs-lambda-docdb-support.md, Finding 1: no multi-document
# transactions locally). Real AWS scales this to multiple instances; local stays
# at one, matching what Floci actually emulates.
resource "aws_docdb_cluster_instance" "this" {
  identifier         = "${var.context.id}-docdb-instance"
  cluster_identifier = aws_docdb_cluster.this.id
  instance_class     = var.instance_class
  engine             = "docdb"

  tags = merge(var.context.tags, { Name = "${var.context.id}-docdb-instance" })
}

# ─── Credentials to Parameter Store ──────────────────────────────────────────────
# Per ADR-0007: non-sensitive config (host/port) in Parameter Store; the password
# stays a Terraform-managed sensitive value, never written in plaintext elsewhere.
resource "aws_ssm_parameter" "docdb_host" {
  name  = "/${var.context.id}/docdb/host"
  type  = "String"
  value = aws_docdb_cluster.this.endpoint

  tags = var.context.tags
}

resource "aws_ssm_parameter" "docdb_port" {
  name  = "/${var.context.id}/docdb/port"
  type  = "String"
  value = tostring(aws_docdb_cluster.this.port)

  tags = var.context.tags
}
```

`infra/modules/database/outputs.tf`:

```hcl
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
```

- [ ] **Step 2: Validate**

```bash
cd infra/modules/database && terraform init -backend=false >/dev/null && terraform fmt -check && terraform validate
```

Expected: same as Task 1 — `fmt -check` silent, `validate` prints
`Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
git add infra/modules/database/
git commit -m "feat(infra): add database module for DocumentDB cluster"
```

---

### Task 3: `infra/modules/lambda/` — function, IAM role, event source mapping; wire all three modules

**Files:**
- Create: `infra/modules/lambda/main.tf`
- Create: `infra/modules/lambda/variables.tf`
- Create: `infra/modules/lambda/outputs.tf`
- Create: `infra/modules/lambda/terraform.tf`
- Modify: `infra/environments/local/main.tf` (add `module "label_events"`,
  `module "messaging"`, `module "database"`, `module "lambda_events_pipeline"`)
- Modify: `infra/environments/local/outputs.tf` (re-export queue URL, DocumentDB
  cluster_identifier/port, Lambda function name)
- Test: none (Terraform-only), plus an `aws` CLI assertion against Floci in Step 3

**Interfaces:**
- Consumes: `var.context`, `var.queue_arn` (from Task 1's `messaging` module output), `var.zip_path`
  (path to the packaged Lambda, produced in Block B), `var.handler` (default
  `"dist/handler.handler"`), `var.runtime` (default `"nodejs20.x"`), `var.environment_variables`
  (map, passed through to `aws_lambda_function.environment`), `var.batch_size` (default `10`).
- Produces: `aws_lambda_function.this`, `aws_iam_role.lambda_exec`,
  `aws_lambda_event_source_mapping.sqs_trigger` (with
  `function_response_types = ["ReportBatchItemFailures"]`), `aws_cloudwatch_log_group.this`,
  output `function_name` (consumed by Task 3 Step 3's verification and later by
  `make env-file`'s local Lambda invoke helpers if any are added).

- [ ] **Step 1: Write the module**

`infra/modules/lambda/terraform.tf`:

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.31.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}
```

`infra/modules/lambda/variables.tf`:

```hcl
variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "queue_arn" {
  description = "ARN of the SQS queue this Lambda's event source mapping polls."
  type        = string
}

variable "source_dir" {
  description = "Directory to zip for the Lambda deployment package (the built dist/ output)."
  type        = string
}

variable "handler" {
  description = "Lambda handler entrypoint."
  type        = string
  default     = "dist/handler.handler"
}

variable "runtime" {
  description = "Lambda runtime."
  type        = string
  default     = "nodejs20.x"
}

variable "environment_variables" {
  description = "Environment variables passed to the Lambda function."
  type        = map(string)
  default     = {}
}

variable "batch_size" {
  description = "Max number of SQS messages per Lambda invocation."
  type        = number
  default     = 10
}

variable "timeout" {
  description = "Lambda function timeout in seconds."
  type        = number
  default     = 30
}

variable "memory_size" {
  description = "Lambda function memory in MB."
  type        = number
  default     = 256
}
```

`infra/modules/lambda/main.tf`:

```hcl
# ─── Deployment package ──────────────────────────────────────────────────────────
data "archive_file" "this" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.module}/.build/${var.context.id}.zip"
}

# ─── IAM execution role ──────────────────────────────────────────────────────────
resource "aws_iam_role" "lambda_exec" {
  name = "${var.context.id}-lambda-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })

  tags = var.context.tags
}

resource "aws_iam_role_policy" "lambda_exec" {
  name = "${var.context.id}-lambda-exec-policy"
  role = aws_iam_role.lambda_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SqsConsume"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ]
        Resource = var.queue_arn
      },
      {
        Sid      = "SesSend"
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = "*"
      },
      {
        Sid    = "Logs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
    ]
  })
}

# ─── Log group ────────────────────────────────────────────────────────────────────
resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.context.id}"
  retention_in_days = 14

  tags = var.context.tags
}

# ─── Lambda function ──────────────────────────────────────────────────────────────
resource "aws_lambda_function" "this" {
  function_name    = var.context.id
  role             = aws_iam_role.lambda_exec.arn
  handler          = var.handler
  runtime          = var.runtime
  filename         = data.archive_file.this.output_path
  source_code_hash = data.archive_file.this.output_base64sha256
  timeout          = var.timeout
  memory_size      = var.memory_size

  environment {
    variables = var.environment_variables
  }

  depends_on = [aws_cloudwatch_log_group.this]

  tags = var.context.tags
}

# ─── SQS event source mapping ──────────────────────────────────────────────────────
# `function_response_types = ["ReportBatchItemFailures"]` MUST be set here, at
# CREATE time. Floci silently drops FunctionResponseTypes on
# update-event-source-mapping (verified — see
# docs/lessons/floci-sqs-lambda-docdb-support.md, Finding 3). If this mapping is
# ever changed such that Terraform would update rather than recreate it, confirm
# the field survives via `aws lambda get-event-source-mapping`; if it doesn't,
# taint and recreate the mapping rather than trusting the update.
resource "aws_lambda_event_source_mapping" "sqs_trigger" {
  event_source_arn                  = var.queue_arn
  function_name                     = aws_lambda_function.this.arn
  batch_size                        = var.batch_size
  function_response_types           = ["ReportBatchItemFailures"]
}
```

`infra/modules/lambda/outputs.tf`:

```hcl
output "function_name" {
  description = "Name of the Lambda function."
  value       = aws_lambda_function.this.function_name
}

output "function_arn" {
  description = "ARN of the Lambda function."
  value       = aws_lambda_function.this.arn
}

output "role_arn" {
  description = "ARN of the Lambda's IAM execution role."
  value       = aws_iam_role.lambda_exec.arn
}
```

- [ ] **Step 2: Wire all three modules into `infra/environments/local/main.tf`**

Add after the existing `module "compute"` block (mirrors the `label_*` + module pattern already
used for `rds_aurora`/`compute`):

```hcl
module "label_events" {
  source      = "../../modules/label"
  namespace   = "3mrai"
  environment = var.environment
  name        = "events"
}

# ─── Messaging (SQS) ────────────────────────────────────────────────────────────
module "messaging" {
  source  = "../../modules/messaging"
  context = { id = module.label_events.id, tags = module.label_events.tags }
}

# ─── DocumentDB ─────────────────────────────────────────────────────────────────
module "database" {
  source              = "../../modules/database"
  context             = { id = "docdb-${module.label_events.id}", tags = module.label_events.tags }
  subnet_ids          = module.networking.subnet_ids
  security_group_ids  = module.networking.security_group_ids
  master_password     = var.docdb_password
}

# ─── Events Pipeline Lambda ─────────────────────────────────────────────────────
# source_dir points at the built dist/ output (Task 4-9 produce it); the zip is
# rebuilt on every apply via the archive_file data source's hash comparison.
module "lambda_events_pipeline" {
  source     = "../../modules/lambda"
  context    = { id = module.label_events.id, tags = module.label_events.tags }
  queue_arn  = module.messaging.queue_arn
  source_dir = "${path.module}/../../../functions/events-pipeline/dist"

  environment_variables = {
    AWS_ENDPOINT_URL     = "http://floci:4566"
    DOCDB_HOST            = "floci-docdb-${module.database.cluster_identifier}"
    DOCDB_PORT            = tostring(module.database.port)
    DOCDB_USERNAME         = module.database.master_username
    DOCDB_PASSWORD        = var.docdb_password
    SES_FROM_ADDRESS      = var.ses_from_address
  }
}
```

Add the matching root variables (`infra/environments/local/variables.tf`, mirroring
`var.db_password`'s existing sensitive pattern):

```hcl
variable "docdb_password" {
  description = "Master password for the DocumentDB cluster."
  type        = string
  sensitive   = true
}

variable "ses_from_address" {
  description = "Verified SES sender identity for events-pipeline emails."
  type        = string
  default     = "no-reply@3mrai.local"
}
```

Add to `infra/environments/local/outputs.tf`:

```hcl
output "events_queue_url" {
  description = "URL of the shared events SQS queue (consumed by Users/Orders publishers)."
  value       = module.messaging.queue_url
}

output "docdb_cluster_identifier" {
  description = "DocumentDB cluster identifier, used to derive the floci-docdb-<id> container name."
  value       = module.database.cluster_identifier
}

output "docdb_port" {
  description = "DocumentDB port."
  value       = module.database.port
}

output "events_lambda_function_name" {
  description = "Name of the events-pipeline Lambda function."
  value       = module.lambda_events_pipeline.function_name
}
```

- [ ] **Step 3: Validate**

```bash
cd infra/modules/lambda && terraform init -backend=false >/dev/null && terraform fmt -check && terraform validate
cd ../../environments/local && terraform fmt -check && terraform validate
```

Expected: both `fmt -check` calls silent, both `validate` calls print
`Success! The configuration is valid.` (the `environments/local` validate requires the module
source paths to resolve, which they will once Tasks 1-2 land alongside this task).

Then, after `terraform apply` (out of scope for this plan's automated steps — the implementer or
main session applies once per the repo's existing bootstrap flow), assert against Floci:

```bash
aws --endpoint-url=http://localhost:4566 lambda get-event-source-mapping \
  --uuid "$(aws --endpoint-url=http://localhost:4566 lambda list-event-source-mappings \
    --function-name 3mrai-local-events --query 'EventSourceMappings[0].UUID' --output text)" \
  --query 'FunctionResponseTypes'
```

Expected output: `["ReportBatchItemFailures"]` (confirms Finding 3's create-time requirement was
honored).

- [ ] **Step 4: Commit**

```bash
git add infra/modules/lambda/ infra/environments/local/main.tf infra/environments/local/variables.tf infra/environments/local/outputs.tf
git commit -m "feat(infra): add lambda module and wire messaging/database/lambda for events-pipeline"
```

---

## Block B — Lambda core (no email yet)

> **Dependency gate:** requires Block A merged and applied — Task 8's repository integration
> test and Task 9's handler need a real queue and DocumentDB cluster reachable on Floci. Tasks
> 4-7 are pure TypeScript and can be written/unit-tested without the emulator, but the block as
> a whole is not verified end-to-end until Block A is live. This is the second stop point per
> the phase-C review flow.

### Task 4: Package scaffold

**Files:**
- Create: `functions/events-pipeline/package.json`
- Create: `functions/events-pipeline/tsconfig.json`
- Create: `functions/events-pipeline/vitest.config.ts`
- Create: `functions/events-pipeline/.eslintrc.cjs` (or `eslint.config.js`, mirroring Users' flat
  config if `services/users/eslint.config.js` exists — check and match its format)
- Modify: `pnpm-workspace.yaml` (add `"functions/events-pipeline"`)
- Test: `npm run build && npm test` (empty test suite passes trivially — proves the toolchain)

**Interfaces:**
- Consumes: nothing yet (scaffold only).
- Produces: the `#shared/*`, `#pipeline/*`, `#domain/*`, `#email/*`, `#handlers/*` subpath
  import aliases every later task's `import` statements rely on. Every subsequent task's file
  paths (`src/domain/envelope.ts`, `src/pipeline/process-record.ts`, etc.) must resolve under
  these.

- [ ] **Step 1: Check Users' eslint config format**

```bash
ls services/users/eslint.config.* services/users/.eslintrc* 2>/dev/null
```

Mirror whichever format exists.

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "@3mrai/events-pipeline",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": "24.18.0"
  },
  "imports": {
    "#shared/*": {
      "development": "./src/shared/*.ts",
      "default": "./dist/shared/*.js"
    },
    "#pipeline/*": {
      "development": "./src/pipeline/*.ts",
      "default": "./dist/pipeline/*.js"
    },
    "#domain/*": {
      "development": "./src/domain/*.ts",
      "default": "./dist/domain/*.js"
    },
    "#email/*": {
      "development": "./src/email/*.ts",
      "default": "./dist/email/*.js"
    },
    "#handlers/*": {
      "development": "./src/handlers/*.ts",
      "default": "./dist/handlers/*.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "email": "email dev --dir emails --port 3000"
  },
  "dependencies": {
    "@aws-sdk/client-ses": "^3.1075.0",
    "@aws-sdk/client-sqs": "^3.1075.0",
    "@react-email/components": "^0.5.0",
    "@react-email/render": "^1.1.0",
    "mongodb": "^6.12.0",
    "nanoid": "^5.1.16",
    "react": "^19.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/aws-lambda": "^8.10.152",
    "@types/node": "^26.0.1",
    "@types/react": "^19.0.0",
    "eslint": "^10.6.0",
    "react-email": "^4.0.0",
    "tsx": "^4.23.0",
    "typescript": "^5.6.0",
    "typescript-eslint": "^8.63.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

Mirror `services/users/tsconfig.json` (module resolution `nodenext`, `strict: true`,
`outDir: "dist"`, `rootDir: "src"`), adjusted for this package's directories.

- [ ] **Step 4: Add to `pnpm-workspace.yaml`**

```yaml
packages:
  - "services/users"
  - "functions/events-pipeline"
  - "e2e"
```

- [ ] **Step 5: Install and verify the toolchain**

```bash
nvm use && corepack enable && pnpm install --frozen-lockfile=false
cd functions/events-pipeline && nvm use && npm test
```

Expected: `pnpm install` succeeds; `vitest run` with no test files reports "No test files
found" (exit code depends on vitest config — set `passWithNoTests: true` in
`vitest.config.ts` so this is not treated as a failure) or exits 0.

- [ ] **Step 6: Commit**

```bash
git add functions/events-pipeline/package.json functions/events-pipeline/tsconfig.json functions/events-pipeline/vitest.config.ts functions/events-pipeline/.eslintrc.cjs pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "build(events-pipeline): scaffold package with subpath imports and vitest"
```

---

### Task 5: `src/domain/envelope.ts` + `src/domain/event.ts`

**Files:**
- Create: `functions/events-pipeline/src/domain/envelope.ts`
- Create: `functions/events-pipeline/src/domain/event.ts`
- Test: `functions/events-pipeline/tests/domain/envelope.test.ts`,
  `functions/events-pipeline/tests/domain/event.test.ts`

**Interfaces:**
- Consumes: nothing (pure Zod schemas).
- Produces: `EnvelopeSchema` (Zod), `type Envelope = z.infer<typeof EnvelopeSchema>` — consumed
  by Task 7 (`process-record.ts`) and Task 9 (`handler.ts`). `EventStatus` union type
  (`"STARTED" | "IN_PROGRESS" | "COMPLETED" | "FAILED"`), `EventDocument` interface (fields:
  `friendlyId`, `event_id`, `order_id`, `user_id`, `type`, `source`, `payload`, `status`,
  `error`, `status_history`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt`, `deletedBy`,
  `deletedAt`) — consumed by Task 8 (`events-repository.ts`).

- [ ] **Step 1: Write the failing test for `EnvelopeSchema`**

`functions/events-pipeline/tests/domain/envelope.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { EnvelopeSchema } from "#domain/envelope";

describe("EnvelopeSchema", () => {
  it("accepts a valid USER_CREATED envelope with a null order_id", () => {
    const result = EnvelopeSchema.safeParse({
      event_id: "evt_abc123",
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_abc123",
      order_id: null,
      payload: { id: "usr_abc123", email: "jo*****e@gmail.com" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an envelope missing event_id", () => {
    const result = EnvelopeSchema.safeParse({
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_abc123",
      order_id: null,
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects an envelope with a non-object payload", () => {
    const result = EnvelopeSchema.safeParse({
      event_id: "evt_abc123",
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_abc123",
      order_id: null,
      payload: "not-an-object",
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, confirm the expected failure**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/domain/envelope.test.ts
```

Expected failure: `Cannot find module '#domain/envelope'` (the module doesn't exist yet).

- [ ] **Step 3: Minimal implementation**

`functions/events-pipeline/src/domain/envelope.ts`:

```typescript
import { z } from "zod";

// The producer→pipeline contract. `type` and `source` are ALSO set as SQS
// message attributes (see the producers in Block D), so the queue can be
// inspected without deserializing the body — this schema validates the body.
export const EnvelopeSchema = z.object({
  event_id: z.string().min(1),
  type: z.string().min(1),
  source: z.string().min(1),
  user_id: z.string().min(1),
  order_id: z.string().min(1).nullable(),
  payload: z.record(z.string(), z.unknown()),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/domain/envelope.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Write the failing test for `EventDocument`/status types**

`functions/events-pipeline/tests/domain/event.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { EVENT_ID_PREFIX, type EventDocument, type EventStatus } from "#domain/event";

describe("event domain constants", () => {
  it("exposes the evt_ friendlyId prefix", () => {
    expect(EVENT_ID_PREFIX).toBe("evt_");
  });

  it("accepts a well-formed EventDocument shape", () => {
    const doc: EventDocument = {
      friendlyId: "evt_abc123",
      event_id: "evt_abc123",
      order_id: null,
      user_id: "usr_abc123",
      type: "USER_CREATED",
      source: "users",
      payload: {},
      status: "STARTED" satisfies EventStatus,
      error: null,
      status_history: [{ status: "STARTED", timestamp: new Date() }],
      createdBy: "events-pipeline",
      createdAt: new Date(),
      updatedBy: "events-pipeline",
      updatedAt: new Date(),
      deletedBy: null,
      deletedAt: null,
    };
    expect(doc.status).toBe("STARTED");
  });
});
```

- [ ] **Step 6: Run it, confirm the expected failure**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/domain/event.test.ts
```

Expected failure: `Cannot find module '#domain/event'`.

- [ ] **Step 7: Minimal implementation**

`functions/events-pipeline/src/domain/event.ts`:

```typescript
// Prefixed nano-id prefix for this collection's friendlyId — see
// docs/shared/conventions/nano-id.md. `event_id` (below) is a DIFFERENT field:
// the producer-generated idempotency key, not the pipeline's own display id.
export const EVENT_ID_PREFIX = "evt_";

export type EventStatus = "STARTED" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

export interface StatusHistoryEntry {
  status: EventStatus;
  timestamp: Date;
  error?: string;
}

// Mirrors docs/domains/events-pipeline/specs/events-pipeline-design.md's Data
// Model table, PLUS `event_id` — new in this milestone (idempotency key, unique
// index alongside friendlyId's own unique index; see the milestone design spec's
// "Idempotency (new field)" section).
export interface EventDocument {
  friendlyId: string;
  event_id: string;
  order_id: string | null;
  user_id: string;
  type: string;
  source: string;
  payload: Record<string, unknown>;
  status: EventStatus;
  error: string | null;
  status_history: StatusHistoryEntry[];
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
  deletedBy: string | null;
  deletedAt: Date | null;
}
```

- [ ] **Step 8: Run test, confirm PASS**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/domain/event.test.ts
```

Expected: 2 passed.

- [ ] **Step 9: Commit**

```bash
git add functions/events-pipeline/src/domain/ functions/events-pipeline/tests/domain/
git commit -m "feat(events-pipeline): add envelope and event document schemas"
```

---

### Task 6: `src/pipeline/errors.ts`

**Files:**
- Create: `functions/events-pipeline/src/pipeline/errors.ts`
- Test: `functions/events-pipeline/tests/pipeline/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class PermanentError extends Error`, `class TransientError extends Error`,
  `function isTransient(err: unknown): boolean` — consumed by Task 7
  (`process-record.ts`, to decide the batch-item-failure branch) and Task 9 (`handler.ts`, to
  build `batchItemFailures`).

- [ ] **Step 1: Write the failing test**

`functions/events-pipeline/tests/pipeline/errors.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { PermanentError, TransientError, isTransient } from "#pipeline/errors";

describe("error classification", () => {
  it("PermanentError is not transient", () => {
    expect(isTransient(new PermanentError("invalid payload"))).toBe(false);
  });

  it("TransientError is transient", () => {
    expect(isTransient(new TransientError("DocumentDB unreachable"))).toBe(true);
  });

  it("an unclassified error is treated as transient (safe default)", () => {
    expect(isTransient(new Error("something unexpected"))).toBe(true);
  });

  it("a non-Error thrown value is treated as transient", () => {
    expect(isTransient("a string was thrown")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, confirm the expected failure**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/pipeline/errors.test.ts
```

Expected failure: `Cannot find module '#pipeline/errors'`.

- [ ] **Step 3: Minimal implementation**

`functions/events-pipeline/src/pipeline/errors.ts`:

```typescript
// Invalid envelope, unknown type, payload that fails validation, missing
// template → persist FAILED and CONSUME the message; retrying can never help.
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

// DocumentDB unreachable, SES down, timeout → goes into batchItemFailures so
// SQS retries it and it eventually lands in the DLQ.
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

// Anything unclassified is treated as transient — the safe default prefers
// retrying over silently losing an event (see the milestone design spec's
// "Error handling" section).
export function isTransient(err: unknown): boolean {
  if (err instanceof PermanentError) return false;
  return true;
}
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/pipeline/errors.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add functions/events-pipeline/src/pipeline/errors.ts functions/events-pipeline/tests/pipeline/errors.test.ts
git commit -m "feat(events-pipeline): add PermanentError/TransientError classification"
```

---

### Task 7: `src/pipeline/process-record.ts` — the state machine

**Files:**
- Create: `functions/events-pipeline/src/pipeline/process-record.ts`
- Test: `functions/events-pipeline/tests/pipeline/process-record.test.ts`

**Interfaces:**
- Consumes: `Envelope` (Task 5), `EventDocument`/`EventStatus`/`StatusHistoryEntry` (Task 5),
  `PermanentError`/`TransientError`/`isTransient` (Task 6).
- Produces: `interface EventsRepositoryPort` (methods: `insertStarted(doc: EventDocument):
  Promise<void>`, `transition(event_id: string, status: EventStatus, patch?: { error?: string
  }): Promise<void>`) — consumed by Task 8's `MongoEventsRepository` (implements the port) and
  by Task 9's `handler.ts` (wires the concrete repository in). `interface HandlerMap` (`Record<string,
  (envelope: Envelope) => Promise<void>>`) — the `type → handler` map, consumed by Task 9
  and populated by Task 10 (`src/handlers/index.ts`). `async function processRecord(envelope:
  Envelope, deps: { repository: EventsRepositoryPort; handlers: HandlerMap }): Promise<{ ok:
  true } | { ok: false; transient: boolean }>` — the function Task 9's `handler.ts` calls per
  SQS record. **Must not import any AWS SDK** — takes an envelope and a repository port only.

- [ ] **Step 1: Write the failing tests (all four transitions + unknown type + status_history append-only)**

`functions/events-pipeline/tests/pipeline/process-record.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { processRecord, type EventsRepositoryPort, type HandlerMap } from "#pipeline/process-record";
import { PermanentError, TransientError } from "#pipeline/errors";
import type { Envelope } from "#domain/envelope";

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    event_id: "evt_test1",
    type: "USER_CREATED",
    source: "users",
    user_id: "usr_test1",
    order_id: null,
    payload: { id: "usr_test1", email: "test@example.com" },
    ...overrides,
  };
}

function makeRepository(): EventsRepositoryPort & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    insertStarted: vi.fn(async (doc) => {
      calls.push(["insertStarted", doc]);
    }),
    transition: vi.fn(async (event_id, status, patch) => {
      calls.push(["transition", event_id, status, patch]);
    }),
  };
}

describe("processRecord", () => {
  it("STARTED -> IN_PROGRESS -> COMPLETED on a successful handler", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = { USER_CREATED: vi.fn(async () => {}) };
    const envelope = makeEnvelope();

    const result = await processRecord(envelope, { repository, handlers });

    expect(result).toEqual({ ok: true });
    expect(repository.insertStarted).toHaveBeenCalledOnce();
    expect(repository.transition).toHaveBeenNthCalledWith(1, "evt_test1", "IN_PROGRESS", undefined);
    expect(repository.transition).toHaveBeenNthCalledWith(2, "evt_test1", "COMPLETED", undefined);
  });

  it("unknown type -> FAILED with 'Unknown event type', handler never invoked", async () => {
    const repository = makeRepository();
    const handler = vi.fn(async () => {});
    const handlers: HandlerMap = { USER_CREATED: handler };
    const envelope = makeEnvelope({ type: "SOMETHING_ELSE" });

    const result = await processRecord(envelope, { repository, handlers });

    expect(result).toEqual({ ok: false, transient: false });
    expect(handler).not.toHaveBeenCalled();
    expect(repository.transition).toHaveBeenCalledWith(
      "evt_test1",
      "FAILED",
      { error: "Unknown event type" },
    );
  });

  it("PermanentError from a handler -> FAILED, not transient", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = {
      USER_CREATED: vi.fn(async () => {
        throw new PermanentError("invalid payload");
      }),
    };

    const result = await processRecord(makeEnvelope(), { repository, handlers });

    expect(result).toEqual({ ok: false, transient: false });
    expect(repository.transition).toHaveBeenCalledWith(
      "evt_test1",
      "FAILED",
      { error: "invalid payload" },
    );
  });

  it("TransientError from a handler -> FAILED persisted, but reported transient", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = {
      USER_CREATED: vi.fn(async () => {
        throw new TransientError("SES unreachable");
      }),
    };

    const result = await processRecord(makeEnvelope(), { repository, handlers });

    expect(result).toEqual({ ok: false, transient: true });
    expect(repository.transition).toHaveBeenCalledWith(
      "evt_test1",
      "FAILED",
      { error: "SES unreachable" },
    );
  });

  it("an unclassified thrown error is treated as transient", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = {
      USER_CREATED: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    const result = await processRecord(makeEnvelope(), { repository, handlers });

    expect(result).toEqual({ ok: false, transient: true });
  });

  it("persists the document BEFORE dispatch (insertStarted precedes transition)", async () => {
    const repository = makeRepository();
    const handlers: HandlerMap = { USER_CREATED: vi.fn(async () => {}) };

    await processRecord(makeEnvelope(), { repository, handlers });

    const kinds = repository.calls.map((c) => (c as unknown[])[0]);
    expect(kinds[0]).toBe("insertStarted");
  });
});
```

- [ ] **Step 2: Run it, confirm the expected failure**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/pipeline/process-record.test.ts
```

Expected failure: `Cannot find module '#pipeline/process-record'`.

- [ ] **Step 3: Minimal implementation**

`functions/events-pipeline/src/pipeline/process-record.ts`:

```typescript
import type { Envelope } from "#domain/envelope";
import type { EventDocument, EventStatus } from "#domain/event";
import { EVENT_ID_PREFIX } from "#domain/event";
import { PermanentError, isTransient } from "#pipeline/errors";

// Port the state machine depends on — implemented by Task 8's
// MongoEventsRepository. Deliberately NOT the AWS/Mongo SDK type: this file
// must not import any AWS SDK, which is what makes it unit-testable without
// the emulator.
export interface EventsRepositoryPort {
  insertStarted(doc: EventDocument): Promise<void>;
  transition(event_id: string, status: EventStatus, patch?: { error?: string }): Promise<void>;
}

export type HandlerMap = Record<string, (envelope: Envelope) => Promise<void>>;

export type ProcessRecordResult = { ok: true } | { ok: false; transient: boolean };

function generateFriendlyId(): string {
  // Mirrors services/users/src/shared/id/nano-id.ts's generateId shape
  // (prefix + nanoid()), reimplemented locally to avoid a cross-package
  // dependency on the Users service.
  const { customAlphabet } = require("nanoid") as typeof import("nanoid");
  const nanoid = customAlphabet("0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz", 16);
  return `${EVENT_ID_PREFIX}${nanoid()}`;
}

// One record's full lifecycle: STARTED -> IN_PROGRESS -> COMPLETED | FAILED.
// The document is persisted BEFORE dispatch (insertStarted first) so an event
// with an invalid payload is still recorded as FAILED rather than silently
// dropped — see the milestone design spec's "Ordering decision".
export async function processRecord(
  envelope: Envelope,
  deps: { repository: EventsRepositoryPort; handlers: HandlerMap },
): Promise<ProcessRecordResult> {
  const now = new Date();
  const doc: EventDocument = {
    friendlyId: generateFriendlyId(),
    event_id: envelope.event_id,
    order_id: envelope.order_id,
    user_id: envelope.user_id,
    type: envelope.type,
    source: envelope.source,
    payload: envelope.payload,
    status: "STARTED",
    error: null,
    status_history: [{ status: "STARTED", timestamp: now }],
    createdBy: "events-pipeline",
    createdAt: now,
    updatedBy: "events-pipeline",
    updatedAt: now,
    deletedBy: null,
    deletedAt: null,
  };

  await deps.repository.insertStarted(doc);

  const handler = deps.handlers[envelope.type];
  if (!handler) {
    await deps.repository.transition(envelope.event_id, "FAILED", { error: "Unknown event type" });
    return { ok: false, transient: false };
  }

  await deps.repository.transition(envelope.event_id, "IN_PROGRESS");

  try {
    await handler(envelope);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.repository.transition(envelope.event_id, "FAILED", { error: message });
    return { ok: false, transient: isTransient(err) };
  }

  await deps.repository.transition(envelope.event_id, "COMPLETED");
  return { ok: true };
}
```

> [!note] `PermanentError` import above
> `PermanentError` is imported for documentation/type purposes even though `isTransient` is what
> actually branches — keep the import only if a lint rule would otherwise flag an unused
> re-export; otherwise drop it and rely solely on `isTransient`.

- [ ] **Step 4: Run test, confirm PASS**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/pipeline/process-record.test.ts
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add functions/events-pipeline/src/pipeline/process-record.ts functions/events-pipeline/tests/pipeline/process-record.test.ts
git commit -m "feat(events-pipeline): add process-record state machine"
```

---

### Task 8: Mongo client + events repository

**Files:**
- Create: `functions/events-pipeline/src/shared/db/client.ts`
- Create: `functions/events-pipeline/src/shared/db/events-repository.ts`
- Create: `functions/events-pipeline/src/shared/config/env.ts`
- Test: `functions/events-pipeline/tests/shared/db/events-repository.integration.test.ts`
  (layer 2, against real Floci DocumentDB — **not mocked**, per the "mocks hide schema bugs"
  hazard called out in the design spec)

**Interfaces:**
- Consumes: `EventDocument`/`EventStatus` (Task 5), `EventsRepositoryPort` (Task 7).
- Produces: `function getMongoClient(): Promise<MongoClient>` (module-scope singleton, reused
  across warm-container invocations), `class MongoEventsRepository implements
  EventsRepositoryPort` (constructor `(db: Db)`), `async function ensureIndexes(db: Db):
  Promise<void>` (creates the unique indexes on `event_id` and `friendlyId`) — consumed by Task 9
  (`handler.ts`, module-scope initialization) and exercised directly by this task's integration
  test.

- [ ] **Step 1: Write `src/shared/config/env.ts`**

```typescript
import { z } from "zod";

// Per ADR-0014: env validation with Zod, parsed once at module load.
const EnvSchema = z.object({
  AWS_ENDPOINT_URL: z.string().url().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  DOCDB_HOST: z.string().min(1),
  DOCDB_PORT: z.coerce.number().default(27017),
  DOCDB_USERNAME: z.string().min(1),
  DOCDB_PASSWORD: z.string().min(1),
  DOCDB_DATABASE: z.string().default("events"),
  SES_FROM_ADDRESS: z.string().email(),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
```

- [ ] **Step 2: Write the failing integration test**

`functions/events-pipeline/tests/shared/db/events-repository.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { MongoEventsRepository, ensureIndexes } from "#shared/db/events-repository";
import { env } from "#shared/config/env";

// Layer 2 — real persistence against Floci's DocumentDB, connecting by
// container name from inside the Docker network (see
// docs/lessons/floci-sqs-lambda-docdb-support.md — port 27017 is not
// published to the host, so this test must run inside the 3mrai network,
// e.g. via `docker compose exec` or an equivalent test runner container).
describe("MongoEventsRepository (integration)", () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = new MongoClient(
      `mongodb://${env.DOCDB_USERNAME}:${env.DOCDB_PASSWORD}@${env.DOCDB_HOST}:${env.DOCDB_PORT}/${env.DOCDB_DATABASE}?tls=false`,
    );
    await client.connect();
    db = client.db(env.DOCDB_DATABASE);
    await ensureIndexes(db);
  });

  afterAll(async () => {
    await db.collection("events").deleteMany({ user_id: { $regex: /^usr_e2e_/ } });
    await client.close();
  });

  it("persists a full document including audit fields and friendlyId", async () => {
    const repo = new MongoEventsRepository(db);
    const doc = {
      friendlyId: "evt_e2e_test1",
      event_id: "evt_e2e_test1",
      order_id: null,
      user_id: "usr_e2e_test1",
      type: "USER_CREATED",
      source: "users",
      payload: { id: "usr_e2e_test1" },
      status: "STARTED" as const,
      error: null,
      status_history: [{ status: "STARTED" as const, timestamp: new Date() }],
      createdBy: "events-pipeline",
      createdAt: new Date(),
      updatedBy: "events-pipeline",
      updatedAt: new Date(),
      deletedBy: null,
      deletedAt: null,
    };

    await repo.insertStarted(doc);
    const found = await db.collection("events").findOne({ event_id: "evt_e2e_test1" });

    expect(found).not.toBeNull();
    expect(found?.friendlyId).toBe("evt_e2e_test1");
    expect(found?.createdBy).toBe("events-pipeline");
  });

  it("$push appends to status_history on transition, without overwriting prior entries", async () => {
    const repo = new MongoEventsRepository(db);
    await repo.transition("evt_e2e_test1", "IN_PROGRESS");
    await repo.transition("evt_e2e_test1", "COMPLETED");

    const found = await db.collection("events").findOne({ event_id: "evt_e2e_test1" });
    const statuses = (found?.status_history as { status: string }[]).map((h) => h.status);

    expect(statuses).toEqual(["STARTED", "IN_PROGRESS", "COMPLETED"]);
    expect(found?.status).toBe("COMPLETED");
  });

  it("rejects a second insert with the same event_id (unique index, idempotency)", async () => {
    const repo = new MongoEventsRepository(db);
    const dup = {
      friendlyId: "evt_e2e_test2",
      event_id: "evt_e2e_test1", // same event_id as above — must collide
      order_id: null,
      user_id: "usr_e2e_test1",
      type: "USER_CREATED",
      source: "users",
      payload: {},
      status: "STARTED" as const,
      error: null,
      status_history: [{ status: "STARTED" as const, timestamp: new Date() }],
      createdBy: "events-pipeline",
      createdAt: new Date(),
      updatedBy: "events-pipeline",
      updatedAt: new Date(),
      deletedBy: null,
      deletedAt: null,
    };

    await expect(repo.insertStarted(dup)).rejects.toThrow();

    const count = await db.collection("events").countDocuments({ event_id: "evt_e2e_test1" });
    expect(count).toBe(1); // no duplicate row — idempotency confirmed
  });
});
```

- [ ] **Step 3: Run it, confirm the expected failure**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/shared/db/events-repository.integration.test.ts
```

Expected failure: `Cannot find module '#shared/db/events-repository'`.

- [ ] **Step 4: Minimal implementation**

`functions/events-pipeline/src/shared/db/client.ts`:

```typescript
import { MongoClient } from "mongodb";
import { env } from "#shared/config/env";

// Module-scope singleton — reused across warm-container invocations, per the
// milestone design spec's "DocumentDB client" section. No transactions: the
// flow is one insert plus a single-document $set/$push, atomic in MongoDB on
// its own (see docs/lessons/floci-sqs-lambda-docdb-support.md — Floci's
// standalone mongo:7.0 container has no replica set and cannot run
// multi-document transactions; real AWS DocumentDB can, from engine 4.0+).
let clientPromise: Promise<MongoClient> | undefined;

export function getMongoClient(): Promise<MongoClient> {
  if (!clientPromise) {
    const client = new MongoClient(
      `mongodb://${env.DOCDB_USERNAME}:${env.DOCDB_PASSWORD}@${env.DOCDB_HOST}:${env.DOCDB_PORT}/${env.DOCDB_DATABASE}?tls=false`,
    );
    clientPromise = client.connect();
  }
  return clientPromise;
}
```

`functions/events-pipeline/src/shared/db/events-repository.ts`:

```typescript
import type { Db } from "mongodb";
import type { EventsRepositoryPort } from "#pipeline/process-record";
import type { EventDocument, EventStatus } from "#domain/event";
import { TransientError } from "#pipeline/errors";

const COLLECTION = "events";

// Both indexes are unique and distinct: friendlyId is the pipeline's own
// evt_-prefixed display id; event_id is the PRODUCER's idempotency key. See
// the milestone design spec's "Idempotency (new field)" section.
export async function ensureIndexes(db: Db): Promise<void> {
  const collection = db.collection(COLLECTION);
  await collection.createIndex({ event_id: 1 }, { unique: true });
  await collection.createIndex({ friendlyId: 1 }, { unique: true });
  await collection.createIndex({ order_id: 1 });
  await collection.createIndex({ user_id: 1 });
  await collection.createIndex({ type: 1 });
  await collection.createIndex({ status: 1 });
  await collection.createIndex({ createdAt: 1 });
}

export class MongoEventsRepository implements EventsRepositoryPort {
  constructor(private readonly db: Db) {}

  async insertStarted(doc: EventDocument): Promise<void> {
    try {
      await this.db.collection(COLLECTION).insertOne(doc);
    } catch (err) {
      // Mongo duplicate-key error code 11000 — the event_id unique index
      // rejected a retry delivery. Treat as a transient condition report
      // (SQS will not redeliver a message it already deleted, but a caller
      // higher up may still want to distinguish "already processed" from a
      // real DB outage) — surfaced as a TransientError so the state machine's
      // classification stays consistent, per docs/lessons/
      // floci-sqs-lambda-docdb-support.md's verified duplicate-key behavior.
      if (typeof err === "object" && err !== null && "code" in err && err.code === 11000) {
        throw new TransientError(`duplicate event_id: ${doc.event_id}`);
      }
      throw err;
    }
  }

  async transition(event_id: string, status: EventStatus, patch?: { error?: string }): Promise<void> {
    const now = new Date();
    await this.db.collection(COLLECTION).updateOne(
      { event_id },
      {
        $set: {
          status,
          updatedAt: now,
          updatedBy: "events-pipeline",
          ...(patch?.error !== undefined ? { error: patch.error } : {}),
        },
        $push: {
          status_history: { status, timestamp: now, ...(patch?.error !== undefined ? { error: patch.error } : {}) },
        },
      },
    );
  }
}
```

- [ ] **Step 5: Run test against Floci, confirm PASS**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/shared/db/events-repository.integration.test.ts
```

Expected: 3 passed (requires Block A's `database` module applied and reachable — run from
inside the Docker network, e.g. `docker compose exec events-pipeline npm test -- events-repository.integration`
once Task 13's compose reconciliation exists, or a temporary runner container in the interim).

- [ ] **Step 6: Commit**

```bash
git add functions/events-pipeline/src/shared/db/ functions/events-pipeline/src/shared/config/ functions/events-pipeline/tests/shared/db/
git commit -m "feat(events-pipeline): add Mongo client and events repository with unique indexes"
```

---

### Task 9: `src/handler.ts` — Lambda entrypoint

**Files:**
- Create: `functions/events-pipeline/src/handler.ts`
- Create: `functions/events-pipeline/src/handlers/index.ts` (empty `HandlerMap` for now — Task
  10 populates `USER_CREATED`)
- Modify: `functions/events-pipeline/CLAUDE.md` §1 (fix "Local: a worker service via
  docker-watch" — see "Reconciliation during implementation" below; done here since this task
  is where the Lambda entrypoint that makes the worker service obsolete lands)
- Test: `functions/events-pipeline/tests/handler.test.ts`

**Interfaces:**
- Consumes: `processRecord` + `EventsRepositoryPort` + `HandlerMap` (Task 7),
  `MongoEventsRepository` + `getMongoClient` (Task 8), `EnvelopeSchema` (Task 5).
- Produces: `export async function handler(event: { Records: { messageId: string; body: string
  }[] }): Promise<{ batchItemFailures: { itemIdentifier: string }[] }>` — the
  `aws_lambda_event_source_mapping` invokes this via `dist/handler.handler` (matches Task 3's
  `var.handler` default). `handlers` map imported from `src/handlers/index.ts`, extended in
  Task 10 and Task 11 without changing this file.

- [ ] **Step 1: Write the failing tests**

`functions/events-pipeline/tests/handler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("#shared/db/client", () => ({ getMongoClient: vi.fn() }));
vi.mock("#shared/db/events-repository", () => ({
  MongoEventsRepository: vi.fn().mockImplementation(() => ({
    insertStarted: vi.fn(async () => {}),
    transition: vi.fn(async () => {}),
  })),
  ensureIndexes: vi.fn(async () => {}),
}));
vi.mock("#handlers/index", () => ({
  handlers: {
    USER_CREATED: vi.fn(async () => {}),
    FLAKY: vi.fn(async () => {
      const { TransientError } = require("#pipeline/errors");
      throw new TransientError("simulated outage");
    }),
  },
}));

import { handler } from "../src/handler.ts";

function sqsRecord(messageId: string, body: unknown) {
  return { messageId, body: JSON.stringify(body) };
}

describe("handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("processes a good record and reports no batch item failures", async () => {
    const result = await handler({
      Records: [
        sqsRecord("msg-1", {
          event_id: "evt_1",
          type: "USER_CREATED",
          source: "users",
          user_id: "usr_1",
          order_id: null,
          payload: { id: "usr_1", email: "a@example.com" },
        }),
      ],
    });

    expect(result.batchItemFailures).toEqual([]);
  });

  it("assembles batchItemFailures for a transient failure, leaves the good message out", async () => {
    const result = await handler({
      Records: [
        sqsRecord("msg-good", {
          event_id: "evt_good",
          type: "USER_CREATED",
          source: "users",
          user_id: "usr_1",
          order_id: null,
          payload: {},
        }),
        sqsRecord("msg-bad", {
          event_id: "evt_bad",
          type: "FLAKY",
          source: "users",
          user_id: "usr_1",
          order_id: null,
          payload: {},
        }),
      ],
    });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-bad" }]);
  });

  it("a malformed envelope (fails Zod) is treated as permanent, not retried", async () => {
    const result = await handler({
      Records: [sqsRecord("msg-malformed", { not: "a valid envelope" })],
    });

    expect(result.batchItemFailures).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, confirm the expected failure**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/handler.test.ts
```

Expected failure: `Cannot find module '../src/handler.ts'` (or a resolution error — the file
doesn't exist yet).

- [ ] **Step 3: Minimal implementation**

`functions/events-pipeline/src/handlers/index.ts`:

```typescript
import type { HandlerMap } from "#pipeline/process-record";

// type -> handler map. Adding a type is one entry here — see the milestone
// design spec's "Implementation order" section: USER_CREATED lands in Task 10,
// ORDER_CREATED in Task 11, proving this claim rather than assuming it.
export const handlers: HandlerMap = {};
```

`functions/events-pipeline/src/handler.ts`:

```typescript
import { EnvelopeSchema } from "#domain/envelope";
import { processRecord } from "#pipeline/process-record";
import { getMongoClient } from "#shared/db/client";
import { MongoEventsRepository, ensureIndexes } from "#shared/db/events-repository";
import { handlers } from "#handlers/index";
import { env } from "#shared/config/env";

interface SqsRecord {
  messageId: string;
  body: string;
}

interface SqsEvent {
  Records: SqsRecord[];
}

interface BatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

let indexesEnsured = false;

// Lambda entrypoint (dist/handler.handler, per infra/modules/lambda's
// var.handler default). Iterates Records, assembles batchItemFailures from
// TransientErrors — verified working on Floci per
// docs/lessons/floci-sqs-lambda-docdb-support.md (partial batch responses are
// honored correctly: only the failed item is retried).
export async function handler(event: SqsEvent): Promise<BatchResponse> {
  const client = await getMongoClient();
  const db = client.db(env.DOCDB_DATABASE);
  if (!indexesEnsured) {
    await ensureIndexes(db);
    indexesEnsured = true;
  }
  const repository = new MongoEventsRepository(db);

  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    let parsed;
    try {
      parsed = EnvelopeSchema.parse(JSON.parse(record.body));
    } catch {
      // Malformed body: cannot even be classified by the state machine
      // (there's no valid event_id to persist against). Treated as
      // permanent — log and drop, do not retry an envelope that can never
      // parse correctly.
      continue;
    }

    const result = await processRecord(parsed, { repository, handlers });
    if (!result.ok && result.transient) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/handler.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Fix `functions/events-pipeline/CLAUDE.md` §1**

Change:

```
- Production: AWS Lambda. Local: a worker service via docker-watch.
```

to:

```
- Production: AWS Lambda. Local: also a real Lambda on Floci (Terraform
  deploys the function + SQS event source mapping) — NOT a compose worker.
  See [[events-pipeline-design]] and [[floci-sqs-lambda-docdb-support]].
  Re-deploying the zip on code changes trades away docker-watch hot-reload,
  in exchange for the event source mapping actually being exercised locally.
```

Also update §2 "Run local" line, since docker-watch no longer applies:

```
- Run local: `terraform apply` (Block A infra) + `npm run build` inside
  `functions/events-pipeline/`, then re-`terraform apply` to redeploy the zip
  (the archive_file data source's hash triggers a Lambda update automatically
  when dist/ changes). No `docker compose up events-pipeline --watch`.
```

- [ ] **Step 6: Commit**

```bash
git add functions/events-pipeline/src/handler.ts functions/events-pipeline/src/handlers/index.ts functions/events-pipeline/tests/handler.test.ts functions/events-pipeline/CLAUDE.md
git commit -m "feat(events-pipeline): add Lambda handler with batchItemFailures support"
```

---

## Block C — Email

> **Dependency gate:** depends on Block B (needs `processRecord`/`HandlerMap`/`handler.ts`
> already in place — Task 10 populates the `USER_CREATED` entry Task 9 left empty). Verified
> end-to-end only once Block A + Block B are both live on Floci. Third stop point per the
> phase-C review flow.

### Task 10: `USER_CREATED` email — react-email, Mailpit, preview server, sender identity

**Files:**
- Create: `functions/events-pipeline/emails/user-created.tsx`
- Create: `functions/events-pipeline/emails/components/layout.tsx`
- Create: `functions/events-pipeline/src/email/catalog.ts`
- Create: `functions/events-pipeline/src/email/renderer.ts`
- Create: `functions/events-pipeline/src/email/sender.ts`
- Create: `functions/events-pipeline/src/handlers/user-created.ts`
- Modify: `functions/events-pipeline/src/handlers/index.ts` (register `USER_CREATED`)
- Modify: `docker-compose.yml` (add `mailpit` service; add `email-preview` service behind a
  `preview` profile)
- Modify: `infra/environments/local/main.tf` (add `aws_ses_email_identity` /
  `VerifyEmailIdentity` for `var.ses_from_address`)
- Test: `functions/events-pipeline/tests/email/catalog.test.ts` (snapshot render),
  `functions/events-pipeline/tests/handlers/user-created.test.ts` (unit),
  `functions/events-pipeline/tests/email/sender.integration.test.ts` (layer 2, asserts via the
  Mailpit API)

**Interfaces:**
- Consumes: `Envelope` (Task 5), `PermanentError`/`TransientError` (Task 6), `handlers`
  (Task 9, extended here).
- Produces: `interface EmailTemplateEntry<P> { component: (props: P) => JSX.Element; sampleProps:
  P }`, `const catalog: Record<string, EmailTemplateEntry<any>>` (Task 11 adds `order-created` as
  a second entry — this is what "adding a type is one map entry" means for email), `async
  function renderTemplate(templateKey: string, props: unknown): Promise<string>` (HTML string),
  `async function sendEmail(params: { to: string; subject: string; html: string }): Promise<void>`
  (SES `SendEmail`) — consumed by `src/handlers/user-created.ts` and later `order-created.ts`.

- [ ] **Step 1: Write the failing catalog/render test**

`functions/events-pipeline/tests/email/catalog.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { catalog } from "#email/catalog";
import { renderTemplate } from "#email/renderer";

describe("email catalog", () => {
  it("registers user-created with sample props", () => {
    expect(catalog["user-created"]).toBeDefined();
    expect(catalog["user-created"].sampleProps).toHaveProperty("fullName");
  });

  it("every catalog entry renders without throwing and contains expected data", async () => {
    for (const [key, entry] of Object.entries(catalog)) {
      const html = await renderTemplate(key, entry.sampleProps);
      expect(html).toContain("<html");
      expect(html.length).toBeGreaterThan(0);
    }
  });

  it("user-created renders the recipient's full name (snapshot)", async () => {
    const html = await renderTemplate("user-created", { fullName: "Ada Lovelace", email: "ada@example.com" });
    expect(html).toContain("Ada Lovelace");
    expect(html).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run it, confirm the expected failure**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/email/catalog.test.ts
```

Expected failure: `Cannot find module '#email/catalog'`.

- [ ] **Step 3: Minimal implementation — templates + catalog + renderer**

`functions/events-pipeline/emails/components/layout.tsx`:

```tsx
import { Html, Head, Body, Container, Text } from "@react-email/components";
import type { ReactNode } from "react";

export function EmailLayout({ children }: { children: ReactNode }) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: "sans-serif", backgroundColor: "#f6f6f6" }}>
        <Container style={{ backgroundColor: "#ffffff", padding: "24px" }}>
          {children}
          <Text style={{ fontSize: "12px", color: "#888" }}>3MRAI</Text>
        </Container>
      </Body>
    </Html>
  );
}
```

`functions/events-pipeline/emails/user-created.tsx`:

```tsx
import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";

export interface UserCreatedEmailProps {
  fullName: string;
  email: string;
}

export default function UserCreatedEmail({ fullName, email }: UserCreatedEmailProps) {
  return (
    <EmailLayout>
      <Heading>Welcome, {fullName}!</Heading>
      <Text>Your account ({email}) has been created successfully.</Text>
    </EmailLayout>
  );
}
```

`functions/events-pipeline/src/email/catalog.ts`:

```typescript
import UserCreatedEmail, { type UserCreatedEmailProps } from "../../emails/user-created.tsx";

// Single registry: template -> component + sample props. Consumed by
// handlers (to render), the preview server (to list), and tests (for
// snapshots) — one source of truth, adding a template is one entry. See the
// milestone design spec's "src/email/catalog.ts — the key piece" section.
export interface EmailTemplateEntry<P> {
  component: (props: P) => JSX.Element;
  sampleProps: P;
}

export const catalog: Record<string, EmailTemplateEntry<any>> = {
  "user-created": {
    component: UserCreatedEmail,
    sampleProps: { fullName: "Ada Lovelace", email: "ada@example.com" } satisfies UserCreatedEmailProps,
  },
};
```

`functions/events-pipeline/src/email/renderer.ts`:

```typescript
import { render } from "@react-email/render";
import { catalog } from "#email/catalog";
import { PermanentError } from "#pipeline/errors";

export async function renderTemplate(templateKey: string, props: unknown): Promise<string> {
  const entry = catalog[templateKey];
  if (!entry) {
    throw new PermanentError(`missing template: ${templateKey}`);
  }
  return render(entry.component(props));
}
```

`functions/events-pipeline/src/email/sender.ts`:

```typescript
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { env } from "#shared/config/env";
import { TransientError } from "#pipeline/errors";

const client = new SESClient({
  region: env.AWS_REGION,
  ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
});

export async function sendEmail(params: { to: string; subject: string; html: string }): Promise<void> {
  try {
    await client.send(
      new SendEmailCommand({
        Source: env.SES_FROM_ADDRESS,
        Destination: { ToAddresses: [params.to] },
        Message: {
          Subject: { Data: params.subject },
          Body: { Html: { Data: params.html } },
        },
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TransientError(`SES send failed: ${message}`);
  }
}
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/email/catalog.test.ts
```

Expected: 3 passed (the snapshot test creates `__snapshots__/catalog.test.ts.snap` on first run).

- [ ] **Step 5: Write the failing `user-created` handler test**

`functions/events-pipeline/tests/handlers/user-created.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("#email/sender", () => ({ sendEmail: vi.fn(async () => {}) }));

import { userCreatedHandler } from "#handlers/user-created";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";
import type { Envelope } from "#domain/envelope";

describe("userCreatedHandler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("validates, renders, and sends an email for a valid payload", async () => {
    const envelope: Envelope = {
      event_id: "evt_1",
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_1",
      order_id: null,
      payload: { fullName: "Ada Lovelace", email: "ada@example.com" },
    };

    await userCreatedHandler(envelope);

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ada@example.com" }),
    );
  });

  it("throws PermanentError on a payload missing required fields", async () => {
    const envelope: Envelope = {
      event_id: "evt_2",
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_1",
      order_id: null,
      payload: { fullName: "No Email" },
    };

    await expect(userCreatedHandler(envelope)).rejects.toThrow(PermanentError);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run it, confirm the expected failure**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/handlers/user-created.test.ts
```

Expected failure: `Cannot find module '#handlers/user-created'`.

- [ ] **Step 7: Minimal implementation**

`functions/events-pipeline/src/handlers/user-created.ts`:

```typescript
import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";

const UserCreatedPayloadSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
});

// validate payload (Zod) -> render react-email template to HTML -> SES
// SendEmail -> COMPLETED. See the milestone design spec's "Email" section.
export async function userCreatedHandler(envelope: Envelope): Promise<void> {
  const result = UserCreatedPayloadSchema.safeParse(envelope.payload);
  if (!result.success) {
    throw new PermanentError(`invalid USER_CREATED payload: ${result.error.message}`);
  }

  const html = await renderTemplate("user-created", result.data);
  await sendEmail({ to: result.data.email, subject: "Welcome!", html });
}
```

`functions/events-pipeline/src/handlers/index.ts` (modify):

```typescript
import type { HandlerMap } from "#pipeline/process-record";
import { userCreatedHandler } from "#handlers/user-created";

// type -> handler map. Adding a type is one entry here — see the milestone
// design spec's "Implementation order" section: USER_CREATED lands in Task 10,
// ORDER_CREATED in Task 11, proving this claim rather than assuming it.
export const handlers: HandlerMap = {
  USER_CREATED: userCreatedHandler,
};
```

- [ ] **Step 8: Run test, confirm PASS**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/handlers/user-created.test.ts
```

Expected: 2 passed.

- [ ] **Step 9: Add Mailpit + preview server to `docker-compose.yml`**

```yaml
  mailpit:
    image: axllent/mailpit:v1.20
    networks: [3mrai-network]
    ports:
      - "8025:8025" # web UI
      - "1025:1025" # SMTP
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8025/api/v1/info"]
      interval: 5s
      timeout: 3s
      retries: 10

  email-preview:
    build: ./functions/events-pipeline
    command: npm run email
    profiles: ["preview"] # does NOT start on a normal `make up`
    networks: [3mrai-network]
    ports:
      - "3000:3000"
    develop:
      watch:
        - action: sync
          path: ./functions/events-pipeline/emails
          target: /app/emails
```

Also remove the now-obsolete `events-pipeline` compose service (build+watch worker) that this
same task's reconciliation note (see "Reconciliation during implementation" below) requires
dropping — do this here since Mailpit's addition is where the compose file changes anyway.

- [ ] **Step 10: `VerifyEmailIdentity` in local Terraform**

Add to `infra/environments/local/main.tf`, near the `lambda_events_pipeline` module:

```hcl
# ─── SES sender identity ─────────────────────────────────────────────────────────
# VerifyEmailIdentity is immediate on Floci (no DNS flow needed, unlike real
# AWS SES's domain verification).
resource "aws_ses_email_identity" "events_pipeline_sender" {
  email = var.ses_from_address
}
```

Set `FLOCI_SERVICES_SES_SMTP_HOST=mailpit` and `FLOCI_SERVICES_SES_SMTP_PORT=1025` in Floci's
own environment (wherever Floci's compose service already declares its `FLOCI_SERVICES_*`
config — modify that block, do not create a new one).

- [ ] **Step 11: Write and run the layer-2 Mailpit integration test**

`functions/events-pipeline/tests/email/sender.integration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { sendEmail } from "#email/sender";

const MAILPIT_API = "http://localhost:8025/api/v1";

async function pollForMessage(subject: string, timeoutMs = 15000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT_API}/search?query=${encodeURIComponent(`subject:"${subject}"`)}`);
    const data = (await res.json()) as { messages: unknown[] };
    if (data.messages.length > 0) return data.messages[0];
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for an email with subject "${subject}" in Mailpit`);
}

describe("sendEmail (integration, Mailpit)", () => {
  it("delivers a real email visible via the Mailpit API", async () => {
    const uniqueSubject = `Test ${Date.now()}`;
    await sendEmail({ to: "test@example.com", subject: uniqueSubject, html: "<p>hello</p>" });

    const message = await pollForMessage(uniqueSubject);
    expect(message).toBeDefined();
  });
});
```

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/email/sender.integration.test.ts
```

Expected: 1 passed (requires the local stack up: `mailpit` healthy and Floci's SES relay
pointed at it).

- [ ] **Step 12: Commit**

```bash
git add functions/events-pipeline/emails/ functions/events-pipeline/src/email/ functions/events-pipeline/src/handlers/user-created.ts functions/events-pipeline/src/handlers/index.ts functions/events-pipeline/tests/email/ functions/events-pipeline/tests/handlers/ docker-compose.yml infra/environments/local/main.tf
git commit -m "feat(events-pipeline): render and send USER_CREATED email via react-email + SES/Mailpit"
```

---

### Task 11: `ORDER_CREATED` — proves the one-map-entry claim

**Files:**
- Create: `functions/events-pipeline/emails/order-created.tsx`
- Create: `functions/events-pipeline/src/handlers/order-created.ts`
- Modify: `functions/events-pipeline/src/email/catalog.ts` (add `order-created` entry)
- Modify: `functions/events-pipeline/src/handlers/index.ts` (add `ORDER_CREATED` entry — the
  **only** change `handler.ts`/`process-record.ts` need; neither file is touched by this task)
- Test: `functions/events-pipeline/tests/handlers/order-created.test.ts`,
  extend `functions/events-pipeline/tests/email/catalog.test.ts`'s loop (already iterates
  `Object.entries(catalog)`, so no test-file change needed there — it automatically covers the
  new entry)

**Interfaces:**
- Consumes: `catalog`/`EmailTemplateEntry` (Task 10), `renderTemplate`/`sendEmail` (Task 10),
  `HandlerMap` (Task 7), `PermanentError` (Task 6).
- Produces: `orderCreatedHandler(envelope: Envelope): Promise<void>`, registered under
  `ORDER_CREATED` in `handlers`.

- [ ] **Step 1: Write the failing handler test**

`functions/events-pipeline/tests/handlers/order-created.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("#email/sender", () => ({ sendEmail: vi.fn(async () => {}) }));

import { orderCreatedHandler } from "#handlers/order-created";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";
import type { Envelope } from "#domain/envelope";

describe("orderCreatedHandler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("validates, renders, and sends an order confirmation email", async () => {
    const envelope: Envelope = {
      event_id: "evt_order_1",
      type: "ORDER_CREATED",
      source: "orders",
      user_id: "usr_1",
      order_id: "ord_1",
      payload: { orderId: "ord_1", email: "ada@example.com", totalCents: 4599 },
    };

    await orderCreatedHandler(envelope);

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ada@example.com" }),
    );
  });

  it("throws PermanentError on a payload missing required fields", async () => {
    const envelope: Envelope = {
      event_id: "evt_order_2",
      type: "ORDER_CREATED",
      source: "orders",
      user_id: "usr_1",
      order_id: "ord_2",
      payload: { orderId: "ord_2" },
    };

    await expect(orderCreatedHandler(envelope)).rejects.toThrow(PermanentError);
  });
});
```

- [ ] **Step 2: Run it, confirm the expected failure**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/handlers/order-created.test.ts
```

Expected failure: `Cannot find module '#handlers/order-created'`.

- [ ] **Step 3: Minimal implementation**

`functions/events-pipeline/emails/order-created.tsx`:

```tsx
import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";

export interface OrderCreatedEmailProps {
  orderId: string;
  totalCents: number;
}

export default function OrderCreatedEmail({ orderId, totalCents }: OrderCreatedEmailProps) {
  return (
    <EmailLayout>
      <Heading>Order confirmed</Heading>
      <Text>
        Your order {orderId} for ${(totalCents / 100).toFixed(2)} has been placed.
      </Text>
    </EmailLayout>
  );
}
```

`functions/events-pipeline/src/email/catalog.ts` (add, do not replace the existing entry):

```typescript
import OrderCreatedEmail, { type OrderCreatedEmailProps } from "../../emails/order-created.tsx";

// ... inside the existing `catalog` object, add:
  "order-created": {
    component: OrderCreatedEmail,
    sampleProps: { orderId: "ord_sample1", totalCents: 4599 } satisfies OrderCreatedEmailProps,
  },
```

`functions/events-pipeline/src/handlers/order-created.ts`:

```typescript
import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";

const OrderCreatedPayloadSchema = z.object({
  orderId: z.string().min(1),
  email: z.string().email(),
  totalCents: z.number().int().nonnegative(),
});

export async function orderCreatedHandler(envelope: Envelope): Promise<void> {
  const result = OrderCreatedPayloadSchema.safeParse(envelope.payload);
  if (!result.success) {
    throw new PermanentError(`invalid ORDER_CREATED payload: ${result.error.message}`);
  }

  const html = await renderTemplate("order-created", result.data);
  await sendEmail({ to: result.data.email, subject: "Order confirmed", html });
}
```

`functions/events-pipeline/src/handlers/index.ts` (modify — the ONLY dispatch-map change this
task makes; `handler.ts` and `process-record.ts` are untouched, which is what proves the
milestone design spec's "adding a type is one map entry" claim):

```typescript
import type { HandlerMap } from "#pipeline/process-record";
import { userCreatedHandler } from "#handlers/user-created";
import { orderCreatedHandler } from "#handlers/order-created";

export const handlers: HandlerMap = {
  USER_CREATED: userCreatedHandler,
  ORDER_CREATED: orderCreatedHandler,
};
```

- [ ] **Step 4: Run tests, confirm PASS**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/handlers/order-created.test.ts tests/email/catalog.test.ts
```

Expected: 2 passed (order-created) + 3 passed (catalog, now iterating 2 entries — proving
`renderTemplate` needed no change either).

- [ ] **Step 5: Commit**

```bash
git add functions/events-pipeline/emails/order-created.tsx functions/events-pipeline/src/handlers/order-created.ts functions/events-pipeline/src/email/catalog.ts functions/events-pipeline/src/handlers/index.ts functions/events-pipeline/tests/handlers/order-created.test.ts
git commit -m "feat(events-pipeline): add ORDER_CREATED handler and email template"
```

---

### Task 12: `TRACKING_STATUS_CHANGED` template family + handler — one type, four variants

**Files:**
- Create: `functions/events-pipeline/emails/tracking-status-changed.tsx`
- Create: `functions/events-pipeline/src/handlers/tracking-status-changed.ts`
- Modify: `functions/events-pipeline/src/email/catalog.ts` (add four entries — one per status —
  all backed by the SAME `tracking-status-changed.tsx` component)
- Modify: `functions/events-pipeline/src/handlers/index.ts` (register **one** `TRACKING_STATUS_CHANGED`
  entry — the fan-out to four templates happens inside the handler, not as four dispatch keys)
- Test: `functions/events-pipeline/tests/handlers/tracking-status-changed.test.ts` (payload
  schema valid + invalid, template selection by status, unknown status → `PermanentError`),
  extend `functions/events-pipeline/tests/email/catalog.test.ts`'s loop (already iterates
  `Object.entries(catalog)`, so no test-file change needed there — it automatically covers all
  four new entries)

**Interfaces:**
- Consumes: `catalog`/`EmailTemplateEntry` (Task 10), `renderTemplate`/`sendEmail` (Task 10),
  `HandlerMap` (Task 7), `PermanentError` (Task 6), `Envelope` (Task 5).
- Produces: `trackingStatusChangedHandler(envelope: Envelope): Promise<void>`, registered under
  a single `TRACKING_STATUS_CHANGED` key in `handlers`.

Contrast with Task 11: Task 11 proved a new **event type** is one dispatch-map entry. This task
proves the opposite direction of the same claim — one event type can fan out to **several
rendered templates** (`SHIPPED`, `ON_THE_WAY`, `OUT_FOR_DELIVERY`, `DELIVERED`) without adding
new dispatch entries, because the variation lives in `catalog.ts`'s keying and the handler's
template-selection-by-`payload.status`, not in the event taxonomy. See the milestone design
spec's "Producer wiring → Tracking → One event type, not four" for the rejected
per-status-type alternative.

- [ ] **Step 1: Write the failing handler test**

`functions/events-pipeline/tests/handlers/tracking-status-changed.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("#email/sender", () => ({ sendEmail: vi.fn(async () => {}) }));

import { trackingStatusChangedHandler } from "#handlers/tracking-status-changed";
import { sendEmail } from "#email/sender";
import { renderTemplate } from "#email/renderer";
import { PermanentError } from "#pipeline/errors";
import type { Envelope } from "#domain/envelope";

function makeEnvelope(status: string, previousStatus: string): Envelope {
  return {
    event_id: `evt_tracking_${status.toLowerCase()}`,
    type: "TRACKING_STATUS_CHANGED",
    source: "tracking",
    user_id: "usr_1",
    order_id: "ord_1",
    payload: {
      status,
      previous_status: previousStatus,
      changed_at: "2026-08-03T12:00:00.000Z",
      email: "ada@example.com",
    },
  };
}

describe("trackingStatusChangedHandler", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["SHIPPED", "null"],
    ["ON_THE_WAY", "SHIPPED"],
    ["OUT_FOR_DELIVERY", "ON_THE_WAY"],
    ["DELIVERED", "OUT_FOR_DELIVERY"],
  ])("selects the %s template variant and sends an email", async (status, previous) => {
    await trackingStatusChangedHandler(makeEnvelope(status, previous));

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "ada@example.com" }),
    );
  });

  it("renders the DELIVERED variant distinctly (no transition is exempt from email)", async () => {
    await trackingStatusChangedHandler(makeEnvelope("DELIVERED", "OUT_FOR_DELIVERY"));

    const html = await renderTemplate("tracking-status-changed-delivered", {
      orderId: "ord_1",
      status: "DELIVERED",
      previousStatus: "OUT_FOR_DELIVERY",
    });
    expect(html).toContain("Delivered");
  });

  it("throws PermanentError on an unknown status", async () => {
    await expect(
      trackingStatusChangedHandler(makeEnvelope("LOST_IN_TRANSIT", "SHIPPED")),
    ).rejects.toThrow(PermanentError);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("throws PermanentError on a payload missing required fields", async () => {
    const envelope: Envelope = {
      event_id: "evt_tracking_bad",
      type: "TRACKING_STATUS_CHANGED",
      source: "tracking",
      user_id: "usr_1",
      order_id: "ord_1",
      payload: { status: "SHIPPED" }, // missing previous_status, changed_at, email
    };

    await expect(trackingStatusChangedHandler(envelope)).rejects.toThrow(PermanentError);
  });
});
```

- [ ] **Step 2: Run it, confirm the expected failure**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/handlers/tracking-status-changed.test.ts
```

Expected failure: `Cannot find module '#handlers/tracking-status-changed'`.

- [ ] **Step 3: Minimal implementation**

`functions/events-pipeline/emails/tracking-status-changed.tsx` — ONE component, copy varies by
`status`/`previousStatus` props (not four separate `.tsx` files):

```tsx
import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";

export interface TrackingStatusChangedEmailProps {
  orderId: string;
  status: "SHIPPED" | "ON_THE_WAY" | "OUT_FOR_DELIVERY" | "DELIVERED";
  previousStatus: string;
}

const COPY: Record<TrackingStatusChangedEmailProps["status"], { heading: string; body: string }> = {
  SHIPPED: {
    heading: "Your order has shipped",
    body: "has left the warehouse and is on its way to the carrier.",
  },
  ON_THE_WAY: {
    heading: "Your order is on the way",
    body: "is now on the way to you.",
  },
  OUT_FOR_DELIVERY: {
    heading: "Out for delivery",
    body: "is out for delivery today.",
  },
  DELIVERED: {
    heading: "Delivered",
    body: "has been delivered.",
  },
};

export default function TrackingStatusChangedEmail({
  orderId,
  status,
  previousStatus,
}: TrackingStatusChangedEmailProps) {
  const { heading, body } = COPY[status];
  return (
    <EmailLayout>
      <Heading>{heading}</Heading>
      <Text>
        Order {orderId} {body} (previously: {previousStatus}).
      </Text>
    </EmailLayout>
  );
}
```

`functions/events-pipeline/src/email/catalog.ts` (add, do not replace existing entries — four
catalog entries, ONE component, per the milestone design spec's "`tracking-status-changed`
template family" section):

```typescript
import TrackingStatusChangedEmail, {
  type TrackingStatusChangedEmailProps,
} from "../../emails/tracking-status-changed.tsx";

// ... inside the existing `catalog` object, add:
  "tracking-status-changed-shipped": {
    component: TrackingStatusChangedEmail,
    sampleProps: {
      orderId: "ord_sample1",
      status: "SHIPPED",
      previousStatus: "null",
    } satisfies TrackingStatusChangedEmailProps,
  },
  "tracking-status-changed-on-the-way": {
    component: TrackingStatusChangedEmail,
    sampleProps: {
      orderId: "ord_sample1",
      status: "ON_THE_WAY",
      previousStatus: "SHIPPED",
    } satisfies TrackingStatusChangedEmailProps,
  },
  "tracking-status-changed-out-for-delivery": {
    component: TrackingStatusChangedEmail,
    sampleProps: {
      orderId: "ord_sample1",
      status: "OUT_FOR_DELIVERY",
      previousStatus: "ON_THE_WAY",
    } satisfies TrackingStatusChangedEmailProps,
  },
  "tracking-status-changed-delivered": {
    component: TrackingStatusChangedEmail,
    sampleProps: {
      orderId: "ord_sample1",
      status: "DELIVERED",
      previousStatus: "OUT_FOR_DELIVERY",
    } satisfies TrackingStatusChangedEmailProps,
  },
```

`functions/events-pipeline/src/handlers/tracking-status-changed.ts` — the fan-out lives HERE,
inside the one handler, not as four `HandlerMap` entries:

```typescript
import { z } from "zod";
import type { Envelope } from "#domain/envelope";
import { renderTemplate } from "#email/renderer";
import { sendEmail } from "#email/sender";
import { PermanentError } from "#pipeline/errors";

const TrackingStatusChangedPayloadSchema = z.object({
  status: z.enum(["SHIPPED", "ON_THE_WAY", "OUT_FOR_DELIVERY", "DELIVERED"]),
  previous_status: z.string().min(1),
  changed_at: z.string().min(1),
  email: z.string().email(),
});

// Maps payload.status -> the catalog key for that variant. All four keys back
// the SAME tracking-status-changed.tsx component (see the milestone design
// spec: "one event type, four rendered variants" — the fan-out is here, not
// in the dispatch map).
const TEMPLATE_BY_STATUS: Record<string, string> = {
  SHIPPED: "tracking-status-changed-shipped",
  ON_THE_WAY: "tracking-status-changed-on-the-way",
  OUT_FOR_DELIVERY: "tracking-status-changed-out-for-delivery",
  DELIVERED: "tracking-status-changed-delivered",
};

export async function trackingStatusChangedHandler(envelope: Envelope): Promise<void> {
  const result = TrackingStatusChangedPayloadSchema.safeParse(envelope.payload);
  if (!result.success) {
    throw new PermanentError(`invalid TRACKING_STATUS_CHANGED payload: ${result.error.message}`);
  }

  const templateKey = TEMPLATE_BY_STATUS[result.data.status];
  if (!templateKey) {
    // Zod's enum already rejects anything but the four known statuses, so
    // this branch is unreachable in practice — kept as an explicit guard
    // rather than a silent `undefined` template key reaching renderTemplate.
    throw new PermanentError(`no template for status: ${result.data.status}`);
  }

  const html = await renderTemplate(templateKey, {
    orderId: envelope.order_id,
    status: result.data.status,
    previousStatus: result.data.previous_status,
  });

  await sendEmail({
    to: result.data.email,
    subject: `Order ${envelope.order_id}: ${result.data.status.replace(/_/g, " ").toLowerCase()}`,
    html,
  });
}
```

`functions/events-pipeline/src/handlers/index.ts` (modify — the ONLY dispatch-map change this
task makes: **one** new key for **four** template variants, contrasted explicitly with Task 11's
one-key-per-type):

```typescript
import type { HandlerMap } from "#pipeline/process-record";
import { userCreatedHandler } from "#handlers/user-created";
import { orderCreatedHandler } from "#handlers/order-created";
import { trackingStatusChangedHandler } from "#handlers/tracking-status-changed";

export const handlers: HandlerMap = {
  USER_CREATED: userCreatedHandler,
  ORDER_CREATED: orderCreatedHandler,
  TRACKING_STATUS_CHANGED: trackingStatusChangedHandler,
};
```

- [ ] **Step 4: Run tests, confirm PASS**

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/handlers/tracking-status-changed.test.ts tests/email/catalog.test.ts
```

Expected: 7 passed (tracking-status-changed) + 3 passed (catalog, now iterating 6 entries total —
2 from Tasks 10-11 plus 4 tracking variants — again proving `renderTemplate` needed no change).

- [ ] **Step 5: Commit**

```bash
git add functions/events-pipeline/emails/tracking-status-changed.tsx functions/events-pipeline/src/handlers/tracking-status-changed.ts functions/events-pipeline/src/email/catalog.ts functions/events-pipeline/src/handlers/index.ts functions/events-pipeline/tests/handlers/tracking-status-changed.test.ts
git commit -m "feat(events-pipeline): add TRACKING_STATUS_CHANGED handler with four template variants"
```

---

## Block D — Producers

> **Dependency gate:** depends on Block C (all three handlers — `USER_CREATED`, `ORDER_CREATED`,
> `TRACKING_STATUS_CHANGED` — must exist so an emitted event has somewhere to dispatch to before
> the real producers go live) — fourth and final stop point per the phase-C review flow. Block D
> covers Tasks 13-14: Task 13 replaces the Users and Orders Noops; Task 14 adds Tracking's new
> publisher (Tracking has no Noop to replace — it never published before this milestone).

### Task 13: Replace the Users and Orders Noops; end-to-end verification; compose reconciliation

**Files:**
- Modify: `services/users/src/shared/messaging/event-publisher.ts` (add `SqsEventPublisher`,
  keep `NoopEventPublisher` and the `EventPublisher` interface exactly as-is)
- Modify: `services/users/src/shared/di/awilix-container.ts:71` (swap the `events` registration)
- Modify: `services/users/src/shared/config/env.ts` (add `EVENTS_QUEUE_URL` to the Zod schema)
- Modify: `services/orders/src/Orders.Infrastructure/Messaging/NoopEventPublisher.cs`'s sibling
  — create `services/orders/src/Orders.Infrastructure/Messaging/SqsEventPublisher.cs` (keep
  `NoopEventPublisher.cs` and `IEventPublisher` unchanged)
- Modify: `services/orders/src/Orders.Api/Program.cs:90` (swap the `AddScoped` registration)
- Modify: `infra/environments/local/scripts/generate_env_files.py` (write `EVENTS_QUEUE_URL`
  into both `.env.local.users` and `.env.local.orders`, and generate
  `.env.local.events-pipeline` per [[env-files]]; Task 14 adds the matching
  `.env.local.tracking` entry separately)
- Modify: `docker-compose.yml` (drop the old build+watch `events-pipeline` worker service
  entirely — see "Reconciliation during implementation" below; Task 10 already removed it if
  done there, otherwise finish it here)
- Test: `services/users/tests/shared/messaging/sqs-event-publisher.test.ts` (unit, mocked SQS
  client), `services/orders/tests/Orders.Tests/Messaging/SqsEventPublisherTests.cs` (unit),
  plus the dedicated E2E tests below (layer 3)

This task covers Users and Orders only — both already had a `NoopEventPublisher` seam to
replace. Tracking's publisher is the separate Task 14: it has no existing seam (Tracking never
published events before this milestone), a different language (Python/boto3, not TypeScript/C#),
and a different emission point (a command function, not a DI-registered class).

**Interfaces:**
- Consumes: `EventPublisher` interface (unchanged — `publishUserCreated(payload: { id: string;
  email: string }): Promise<void>`), `IEventPublisher` interface (unchanged —
  `PublishOrderCreatedAsync(orderId, userId, totalCents, createdAt, ct)`), the `EVENTS_QUEUE_URL`
  env var both services read from their own generated env file.
- Produces: `class SqsEventPublisher implements EventPublisher` (Users, TypeScript),
  `class SqsEventPublisher : IEventPublisher` (Orders, C#) — both generate `event_id` internally
  (via `nanoid`/`Guid`-based prefixed id) so the seam signatures stay untouched, per the design
  spec's stated preference.

- [ ] **Step 1: Write the failing Users publisher test**

`services/users/tests/shared/messaging/sqs-event-publisher.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SqsEventPublisher } from "#shared/messaging/event-publisher";

vi.mock("@aws-sdk/client-sqs", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-sqs")>("@aws-sdk/client-sqs");
  return {
    ...actual,
    SQSClient: vi.fn().mockImplementation(() => ({ send: vi.fn().mockResolvedValue({}) })),
  };
});

describe("SqsEventPublisher", () => {
  it("publishes a USER_CREATED envelope with type/source as message attributes", async () => {
    const client = new SQSClient({});
    const publisher = new SqsEventPublisher(client, "http://localhost:4566/000000000000/events");

    await publisher.publishUserCreated({ id: "usr_1", email: "a@example.com" });

    expect(client.send).toHaveBeenCalledOnce();
    const command = (client.send as any).mock.calls[0][0] as SendMessageCommand;
    const input = command.input as any;
    expect(input.QueueUrl).toBe("http://localhost:4566/000000000000/events");
    expect(input.MessageAttributes.type.StringValue).toBe("USER_CREATED");
    expect(input.MessageAttributes.source.StringValue).toBe("users");

    const body = JSON.parse(input.MessageBody);
    expect(body.event_id).toBeTruthy();
    expect(body.user_id).toBe("usr_1");
    expect(body.order_id).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, confirm the expected failure**

```bash
nvm use && cd services/users && npx vitest run tests/shared/messaging/sqs-event-publisher.test.ts
```

Expected failure: `SqsEventPublisher is not exported from '#shared/messaging/event-publisher'`.

- [ ] **Step 3: Minimal implementation — Users**

`services/users/src/shared/messaging/event-publisher.ts` (append, keep the existing
`EventPublisher`/`NoopEventPublisher` exactly as read earlier):

```typescript
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { nanoid } from "nanoid";

// Real implementation. Generates event_id INSIDE the publisher — the seam
// signature (publishUserCreated({ id, email })) stays untouched, per the
// milestone design spec's preferred option.
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publishUserCreated(payload: { id: string; email: string }): Promise<void> {
    const envelope = {
      event_id: `evt_${nanoid()}`,
      type: "USER_CREATED",
      source: "users",
      user_id: payload.id,
      order_id: null,
      payload,
    };

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageAttributes: {
          type: { DataType: "String", StringValue: envelope.type },
          source: { DataType: "String", StringValue: envelope.source },
        },
      }),
    );
  }
}
```

Add `EVENTS_QUEUE_URL: z.string().url()` to `services/users/src/shared/config/env.ts`'s Zod
schema (mirror the existing field style in that file).

`services/users/src/shared/di/awilix-container.ts:71` — replace:

```typescript
events: asFunction(() => new NoopEventPublisher(), { lifetime: Lifetime.SINGLETON }),
```

with:

```typescript
events: asFunction(
  ({ env: cradleEnv }: { env: Env }) =>
    new SqsEventPublisher(
      new SQSClient({ region: cradleEnv.AWS_REGION, endpoint: cradleEnv.AWS_ENDPOINT_URL }),
      cradleEnv.EVENTS_QUEUE_URL,
    ),
  { lifetime: Lifetime.SINGLETON },
),
```

Add the matching import at the top of `awilix-container.ts`:

```typescript
import { SQSClient } from "@aws-sdk/client-sqs";
import { NoopEventPublisher, SqsEventPublisher, type EventPublisher } from "../messaging/event-publisher.ts";
```

(`NoopEventPublisher` stays imported — it remains available for tests that must not emit, per
the design spec.)

- [ ] **Step 4: Run test, confirm PASS**

```bash
nvm use && cd services/users && npx vitest run tests/shared/messaging/sqs-event-publisher.test.ts
```

Expected: 1 passed.

- [ ] **Step 5: Write the failing Orders publisher test**

`services/orders/tests/Orders.Tests/Messaging/SqsEventPublisherTests.cs`:

```csharp
using Amazon.SQS;
using Amazon.SQS.Model;
using Moq;
using Orders.Infrastructure.Messaging;
using Xunit;

namespace Orders.Tests.Messaging;

public class SqsEventPublisherTests
{
    [Fact]
    public async Task PublishOrderCreatedAsync_SendsEnvelopeWithMessageAttributes()
    {
        var sqsMock = new Mock<IAmazonSQS>();
        SendMessageRequest? captured = null;
        sqsMock
            .Setup(s => s.SendMessageAsync(It.IsAny<SendMessageRequest>(), It.IsAny<CancellationToken>()))
            .Callback<SendMessageRequest, CancellationToken>((req, _) => captured = req)
            .ReturnsAsync(new SendMessageResponse());

        var publisher = new SqsEventPublisher(sqsMock.Object, "http://localhost:4566/000000000000/events");

        await publisher.PublishOrderCreatedAsync("ord_1", "usr_1", 4599, DateTime.UtcNow);

        Assert.NotNull(captured);
        Assert.Equal("ORDER_CREATED", captured!.MessageAttributes["type"].StringValue);
        Assert.Equal("orders", captured.MessageAttributes["source"].StringValue);
        Assert.Contains("\"order_id\":\"ord_1\"", captured.MessageBody);
        Assert.Contains("\"event_id\"", captured.MessageBody);
    }
}
```

- [ ] **Step 6: Run it, confirm the expected failure**

```bash
cd services/orders && dotnet test --filter SqsEventPublisherTests
```

Expected failure: build error — `SqsEventPublisher` does not exist.

- [ ] **Step 7: Minimal implementation — Orders**

`services/orders/src/Orders.Infrastructure/Messaging/SqsEventPublisher.cs`:

```csharp
using System.Text.Json;
using Amazon.SQS;
using Amazon.SQS.Model;
using Orders.Application.Abstractions;

namespace Orders.Infrastructure.Messaging;

// Real implementation. Generates event_id INSIDE the publisher — the seam
// signature (PublishOrderCreatedAsync(orderId, userId, totalCents, createdAt, ct))
// stays untouched, per the milestone design spec's preferred option.
public class SqsEventPublisher : IEventPublisher
{
    private readonly IAmazonSQS _client;
    private readonly string _queueUrl;

    public SqsEventPublisher(IAmazonSQS client, string queueUrl)
    {
        _client = client;
        _queueUrl = queueUrl;
    }

    public async Task PublishOrderCreatedAsync(
        string orderId, string userId, long totalCents, DateTime createdAt, CancellationToken ct = default)
    {
        var envelope = new
        {
            event_id = $"evt_{Guid.NewGuid():N}",
            type = "ORDER_CREATED",
            source = "orders",
            user_id = userId,
            order_id = orderId,
            payload = new { orderId, userId, totalCents, createdAt },
        };

        var request = new SendMessageRequest
        {
            QueueUrl = _queueUrl,
            MessageBody = JsonSerializer.Serialize(envelope),
            MessageAttributes = new Dictionary<string, MessageAttributeValue>
            {
                ["type"] = new MessageAttributeValue { DataType = "String", StringValue = envelope.type },
                ["source"] = new MessageAttributeValue { DataType = "String", StringValue = envelope.source },
            },
        };

        await _client.SendMessageAsync(request, ct);
    }
}
```

`services/orders/src/Orders.Api/Program.cs:90` — replace:

```csharp
// ORDER_CREATED emission seam (SQS deferred).
builder.Services.AddScoped<IEventPublisher, NoopEventPublisher>();
```

with:

```csharp
// ORDER_CREATED emission — real SQS publisher, reads the queue URL from this
// service's own generated env file (never hardcoded), per [[env-files]].
builder.Services.AddSingleton<IAmazonSQS>(_ =>
    new AmazonSQSClient(new AmazonSQSConfig
    {
        ServiceURL = builder.Configuration["AWS_ENDPOINT_URL"],
        AuthenticationRegion = builder.Configuration["AWS_REGION"] ?? "us-east-1",
    }));
builder.Services.AddScoped<IEventPublisher>(sp =>
    new SqsEventPublisher(sp.GetRequiredService<IAmazonSQS>(), builder.Configuration["EVENTS_QUEUE_URL"]!));
```

(`NoopEventPublisher.cs` stays in the codebase unchanged, for tests that must not emit.)

- [ ] **Step 8: Run test, confirm PASS**

```bash
cd services/orders && dotnet test --filter SqsEventPublisherTests
```

Expected: 1 passed.

- [ ] **Step 9: Wire `EVENTS_QUEUE_URL` into the env-file generator**

In `infra/environments/local/scripts/generate_env_files.py`'s `build()` function, add:

```python
events_queue_url = terraform_output(tf_dir, "events_queue_url")
docdb_cluster_id = terraform_output(tf_dir, "docdb_cluster_identifier")
docdb_port = terraform_output(tf_dir, "docdb_port")
events_lambda_function_name = terraform_output(tf_dir, "events_lambda_function_name")
```

Add `"EVENTS_QUEUE_URL": events_queue_url` to the dict literals already being written into
`.env.local.users` and `.env.local.orders` (find the existing dict for each service and add
this one key — do not restructure the surrounding dict).

Add a new file entry, mirroring the existing `.env.local.tracking` block:

```python
repo_root / ".env.local.events-pipeline": dict(
    {
        "AWS_ENDPOINT_URL": "http://floci:4566",
        "AWS_REGION": "us-east-1",
        "DOCDB_HOST": f"floci-docdb-{docdb_cluster_id}",
        "DOCDB_PORT": docdb_port,
        "DOCDB_USERNAME": "docdbadmin",
        "SES_FROM_ADDRESS": "no-reply@3mrai.local",
    },
    custom_defaults={
        "DOCDB_PASSWORD": "REPLACE_ME",  # see infra .app-db-secret pattern; not yet in Secrets Manager per ADR-0007
    },
),
```

- [ ] **Step 10: Finish the compose reconciliation**

Confirm the old build+watch `events-pipeline` worker service (the block originally at
`docker-compose.yml:288-313` — build + network wiring only, no ports/DB/healthcheck) is fully
removed. If Task 10 already deleted it, this step is a no-op; otherwise remove it now. The
Lambda runs on Floci via Terraform (Block A + this task's env wiring), so no compose service
runs the events-pipeline code path anymore — `mailpit` and the profiled `email-preview` (Task
10) are the only events-pipeline-related compose services left.

- [ ] **Step 11: End-to-end verification (layer 3) — `POST /v1/users/register` to Mailpit**

This is the plan's Definition of Done, run against a live local stack
(`make infra-down && make bootstrap`, then `terraform apply` with the new modules, then
`make env-file`):

```bash
# 1. Register a user through the real gateway.
curl -s -X POST "$API_GATEWAY_URL/v1/users/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"e2e-events@example.com","password":"Passw0rd!","fullName":"E2E Events"}' \
  | tee /tmp/register-response.json

# 2. Poll DocumentDB for the COMPLETED document (poll, never a fixed sleep —
#    measure over 2-3x the expected processing period per the repo's async-
#    assertion lesson).
timeout 30 bash -c '
  until docker compose exec -T events-pipeline-runner node -e "
    const { MongoClient } = require(\"mongodb\");
    (async () => {
      const client = await MongoClient.connect(process.env.MONGO_URI);
      const doc = await client.db(\"events\").collection(\"events\").findOne({ user_id: process.argv[1] });
      process.exit(doc && doc.status === \"COMPLETED\" ? 0 : 1);
    })();
  " -- "$(jq -r .id /tmp/register-response.json)"; do sleep 2; done
'

# 3. Confirm the email landed in Mailpit.
curl -s "http://localhost:8025/api/v1/search?query=to:e2e-events@example.com" | jq '.messages | length'
```

Expected: step 2 exits 0 within 30s (document reached `COMPLETED`); step 3 returns `1` (exactly
one email, confirming both delivery and — combined with the idempotency test in Task 8 — no
duplicate).

- [ ] **Step 12: Dedicated `batchItemFailures` partial-retry test**

`functions/events-pipeline/tests/handler.integration.test.ts` (layer 3, against the real Lambda
via `aws lambda invoke`, mirroring the manual verification already done in the
[[floci-sqs-lambda-docdb-support]] probe):

```typescript
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

// Injects a batch with one good message and one that triggers a transient
// failure (an ORDER_CREATED envelope with a payload missing `email`, which
// orderCreatedHandler rejects... but as a PermanentError, not transient — so
// instead this test targets a handler-independent transient path: an
// event_id that collides with an existing document AFTER the first insert
// succeeds is treated as TransientError by MongoEventsRepository (Task 8),
// giving a reliable transient trigger without needing to fake SES downtime.
describe("batchItemFailures (integration, real Lambda invoke)", () => {
  it("retries only the transient-failing message, consumes the good one", async () => {
    const functionName = process.env.EVENTS_LAMBDA_FUNCTION_NAME ?? "3mrai-local-events";
    const goodEventId = `evt_batch_good_${Date.now()}`;
    const dupEventId = goodEventId; // reuse the SAME event_id to force the unique-index collision

    const payload = {
      Records: [
        {
          messageId: "batch-good",
          body: JSON.stringify({
            event_id: goodEventId,
            type: "USER_CREATED",
            source: "users",
            user_id: "usr_batch_test",
            order_id: null,
            payload: { fullName: "Batch Good", email: "batch-good@example.com" },
          }),
        },
      ],
    };
    const dupPayload = {
      Records: [
        {
          messageId: "batch-dup",
          body: JSON.stringify({
            event_id: dupEventId,
            type: "USER_CREATED",
            source: "users",
            user_id: "usr_batch_test",
            order_id: null,
            payload: { fullName: "Batch Dup", email: "batch-dup@example.com" },
          }),
        },
      ],
    };

    // First invoke consumes the good message and creates the document.
    const firstResult = JSON.parse(
      execSync(
        `aws --endpoint-url=http://localhost:4566 lambda invoke --function-name ${functionName} --payload '${JSON.stringify(payload).replace(/'/g, "'\\''")}' --cli-binary-format raw-in-base64-out /tmp/batch-first.json && cat /tmp/batch-first.json`,
      ).toString(),
    );
    expect(firstResult.batchItemFailures).toEqual([]);

    // Second invoke with the SAME event_id triggers the unique-index
    // collision, classified TransientError -> reported in batchItemFailures.
    const secondResult = JSON.parse(
      execSync(
        `aws --endpoint-url=http://localhost:4566 lambda invoke --function-name ${functionName} --payload '${JSON.stringify(dupPayload).replace(/'/g, "'\\''")}' --cli-binary-format raw-in-base64-out /tmp/batch-second.json && cat /tmp/batch-second.json`,
      ).toString(),
    );
    expect(secondResult.batchItemFailures).toEqual([{ itemIdentifier: "batch-dup" }]);
  });
});
```

```bash
nvm use && cd functions/events-pipeline && npx vitest run tests/handler.integration.test.ts
```

Expected: 1 passed (requires the local stack up with Block A applied).

- [ ] **Step 13: Commit**

```bash
git add services/users/src/shared/messaging/event-publisher.ts services/users/src/shared/di/awilix-container.ts services/users/src/shared/config/env.ts services/users/tests/shared/messaging/ services/orders/src/Orders.Infrastructure/Messaging/SqsEventPublisher.cs services/orders/src/Orders.Api/Program.cs services/orders/tests/Orders.Tests/Messaging/ infra/environments/local/scripts/generate_env_files.py docker-compose.yml functions/events-pipeline/tests/handler.integration.test.ts
git commit -m "feat(events-pipeline): wire real SQS publishers in Users and Orders, replacing Noops"
```

---

### Task 14: Tracking publisher — third producer, emitting `TRACKING_STATUS_CHANGED`

**Files:**
- Create: `services/tracking/src/shared/messaging/__init__.py`
- Create: `services/tracking/src/shared/messaging/event_publisher.py` (the port —
  `EventPublisher` protocol — plus `NoopEventPublisher`, mirroring `NoopEventPublisher` in
  Users/Orders; the emission model this file follows is `shared/grpc/users_client.py`'s
  lazy-singleton pattern: a module-level `@lru_cache`d factory keyed on primitives from
  `Settings`, NOT a DI container — `services/tracking/src/shared/di/` is an empty placeholder
  package with no framework wiring to hook into)
- Create: `services/tracking/src/shared/messaging/sqs_event_publisher.py` (the real boto3
  implementation)
- Modify: `services/tracking/src/shared/config/settings.py` (add `events_queue_url: str` to
  `Settings`, following the existing `Field(min_length=1)` style)
- Modify: `services/tracking/src/features/tracking/commands/update_status.py` (emit after a
  successful transition — the shared write path for both the carrier webhook and TestMode)
- Test: `services/tracking/tests/shared/messaging/test_sqs_event_publisher.py` (unit, fake
  publisher/mocked boto3 client), `services/tracking/tests/features/tracking/commands/test_update_status.py`
  (extend with emission assertions — unit, using a fake publisher, not a real one), an
  integration test verifying the message lands on the real Floci queue, and an E2E test via
  `services/tracking/tests/` E2E layer per `services/tracking/CLAUDE.md` §2

**Interfaces:**
- Consumes: the persisted `Tracking` entity `update_tracking_status()` already loads and
  returns (specifically `tracking.user_id` — the internal `usr_` id column, confirmed in
  `src/features/tracking/domain/models.py`, distinct from `cognito_sub`), `command.order_id`,
  the transition's `requested`/`current` `TrackingStatus` values, `Settings.events_queue_url`
  (new field, read from `.env.local.tracking` per [[env-files]]).
- Produces: `class EventPublisher(Protocol)` with `publish_tracking_status_changed(*, order_id:
  str, user_id: str, status: str, previous_status: str, changed_at: datetime) -> None`,
  `class NoopEventPublisher` (implements the protocol, does nothing — retained for tests that
  must not emit, mirroring Users/Orders), `class SqsEventPublisher` (implements the protocol via
  boto3 `send_message`), `def shared_event_publisher() -> EventPublisher` (the process-wide
  lazy singleton, mirroring `shared_users_client()` in `users_client.py`) — consumed by
  `update_tracking_status()`.

> [!warning] `user_id` MUST come from the persisted tracking record, not the request
> The carrier webhook (`PUT /v1/trackings/{orderId}/status`) is authenticated by an API key and
> carries **no** `x-user-id` — its repository lookup in `update_status.py` is unscoped
> (`user_id=None`) precisely because there is no request-level identity to scope by (see that
> file's own module docstring, "Why the lookup here is UNSCOPED"). **An implementer who reaches
> for a request-supplied user id here will produce an envelope with no recipient** — there is no
> such id to reach for on this path, and reusing `cognito_sub` would be wrong too (it is the
> ownership key for reads, not the envelope's `user_id`). The ONLY correct source is
> `tracking.user_id` off the `Tracking` entity that `update_tracking_status()` already loads via
> `repository.get_by_order_id(...)` and returns — read it from that returned entity, after
> `repository.update_status(...)` persists the transition, not from any request context.

> [!info] `event_id` derived from `(order_id, status)`, not regenerated per attempt
> Given the forward-only state machine, `(order_id, status)` is a natural key for a transition:
> a tracking can be `SHIPPED` at most once, `ON_THE_WAY` at most once, and so on. Derive
> `event_id` deterministically from this pair (e.g. `f"evt_{order_id}_{status}"`, or a stable
> hash of the two if the pipeline's `event_id` format requires a fixed shape) — **never** mint a
> fresh id on every send/retry attempt. This matters specifically because of TestMode: it fires
> four transitions in ~30 seconds (§5c), and if a transient SQS error caused a retry of the SAME
> transition, a freshly-generated `event_id` would miss the pipeline's unique-index dedupe
> (Task 8) and send a duplicate notification email for a transition that already succeeded.
> Deriving from `(order_id, status)` means a retry of the same transition always collides on the
> same id, which is exactly the idempotency property Task 8's unique index exists to enforce.

- [ ] **Step 1: Write the failing publisher unit test**

`services/tracking/tests/shared/messaging/test_sqs_event_publisher.py`:

```python
"""Unit tests for SqsEventPublisher — mocked boto3 client, no network."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import MagicMock

from src.shared.messaging.sqs_event_publisher import SqsEventPublisher


def test_publish_tracking_status_changed_sends_envelope_with_message_attributes() -> None:
    client = MagicMock()
    publisher = SqsEventPublisher(client=client, queue_url="http://localhost:4566/000000000000/events")

    publisher.publish_tracking_status_changed(
        order_id="ord_1",
        user_id="usr_1",
        status="ON_THE_WAY",
        previous_status="SHIPPED",
        changed_at=datetime(2026, 8, 3, 12, 0, 0, tzinfo=UTC),
    )

    client.send_message.assert_called_once()
    call_kwargs = client.send_message.call_args.kwargs
    assert call_kwargs["QueueUrl"] == "http://localhost:4566/000000000000/events"
    assert call_kwargs["MessageAttributes"]["type"]["StringValue"] == "TRACKING_STATUS_CHANGED"
    assert call_kwargs["MessageAttributes"]["source"]["StringValue"] == "tracking"

    import json

    body = json.loads(call_kwargs["MessageBody"])
    assert body["user_id"] == "usr_1"
    assert body["order_id"] == "ord_1"
    assert body["payload"]["status"] == "ON_THE_WAY"
    assert body["payload"]["previous_status"] == "SHIPPED"


def test_event_id_is_stable_for_the_same_order_id_and_status() -> None:
    """(order_id, status) is the idempotency key — a retry of the same transition
    must collide on the pipeline's unique index (Task 8), never mint a fresh id."""
    client = MagicMock()
    publisher = SqsEventPublisher(client=client, queue_url="http://localhost:4566/000000000000/events")

    publisher.publish_tracking_status_changed(
        order_id="ord_1", user_id="usr_1", status="SHIPPED",
        previous_status="null", changed_at=datetime(2026, 8, 3, tzinfo=UTC),
    )
    publisher.publish_tracking_status_changed(
        order_id="ord_1", user_id="usr_1", status="SHIPPED",
        previous_status="null", changed_at=datetime(2026, 8, 3, 0, 0, 5, tzinfo=UTC),
    )

    import json

    first_body = json.loads(client.send_message.call_args_list[0].kwargs["MessageBody"])
    second_body = json.loads(client.send_message.call_args_list[1].kwargs["MessageBody"])
    assert first_body["event_id"] == second_body["event_id"]
```

- [ ] **Step 2: Run it, confirm the expected failure**

```bash
cd services/tracking && pytest tests/shared/messaging/test_sqs_event_publisher.py
```

Expected failure: `ModuleNotFoundError: No module named 'src.shared.messaging.sqs_event_publisher'`.

- [ ] **Step 3: Minimal implementation — the port, Noop, and SQS publisher**

`services/tracking/src/shared/messaging/__init__.py`: empty (package marker).

`services/tracking/src/shared/messaging/event_publisher.py`:

```python
"""The event-publishing port for Tracking (JE — events-pipeline milestone).

Mirrors `EventPublisher`/`NoopEventPublisher` in Users
(`services/users/src/shared/messaging/event-publisher.ts`) and `IEventPublisher`/
`NoopEventPublisher` in Orders — Tracking's third producer, joining the same shared
SQS queue per docs/superpowers/specs/2026-08-03-events-pipeline-milestone-design.md.

Unlike Users' Awilix container or Orders' DI, Tracking has no framework container —
`shared/di/` is an empty placeholder. The wiring pattern this service already uses
for an outbound dependency is `shared/grpc/users_client.py`'s lazy, `@lru_cache`d
module-level singleton; `shared_event_publisher()` below follows the same shape.
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol


class EventPublisher(Protocol):
    """Port `update_tracking_status()` depends on. Implemented by
    `SqsEventPublisher` (real) and `NoopEventPublisher` (tests that must not emit).
    """

    def publish_tracking_status_changed(
        self,
        *,
        order_id: str,
        user_id: str,
        status: str,
        previous_status: str,
        changed_at: datetime,
    ) -> None: ...


class NoopEventPublisher:
    """Discards every call. Used by tests that must not emit — mirrors
    `NoopEventPublisher` in Users and Orders."""

    def publish_tracking_status_changed(
        self,
        *,
        order_id: str,
        user_id: str,
        status: str,
        previous_status: str,
        changed_at: datetime,
    ) -> None:
        return None
```

`services/tracking/src/shared/messaging/sqs_event_publisher.py`:

```python
"""Real SQS publisher for Tracking's TRACKING_STATUS_CHANGED events.

Python/boto3 counterpart of Users' SqsEventPublisher (TypeScript) and Orders'
SqsEventPublisher (C#) — same envelope shape, same `type`/`source` message
attributes, publishing to the one shared queue
(docs/superpowers/specs/2026-08-03-events-pipeline-milestone-design.md).
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from src.shared.messaging.event_publisher import EventPublisher


class SqsEventPublisher(EventPublisher):
    def __init__(self, *, client: Any, queue_url: str) -> None:
        self._client = client
        self._queue_url = queue_url

    def publish_tracking_status_changed(
        self,
        *,
        order_id: str,
        user_id: str,
        status: str,
        previous_status: str,
        changed_at: datetime,
    ) -> None:
        # event_id derived from (order_id, status) — NOT regenerated per call.
        # This is the transition's natural key: a forward-only state machine
        # visits each status at most once per order, so a retry of the same
        # transition (e.g. after a transient SQS error) collides on the SAME
        # id and the pipeline's unique index (Task 8) treats it as
        # already-processed rather than sending a second notification email.
        # See this task's "event_id derived from (order_id, status)" warning.
        event_id = f"evt_{order_id}_{status}"

        envelope = {
            "event_id": event_id,
            "type": "TRACKING_STATUS_CHANGED",
            "source": "tracking",
            "user_id": user_id,
            "order_id": order_id,
            "payload": {
                "status": status,
                "previous_status": previous_status,
                "changed_at": changed_at.isoformat(),
            },
        }

        self._client.send_message(
            QueueUrl=self._queue_url,
            MessageBody=json.dumps(envelope),
            MessageAttributes={
                "type": {"DataType": "String", "StringValue": envelope["type"]},
                "source": {"DataType": "String", "StringValue": envelope["source"]},
            },
        )
```

Add `events_queue_url: str = Field(min_length=1)` to `services/tracking/src/shared/config/settings.py`'s
`Settings` class (mirror the existing `database_writer_url` style — required, no default, since
`generate_env_files.py` will write it into `.env.local.tracking` in this same task).

Add the lazy-singleton factory to `event_publisher.py` (appended, after `NoopEventPublisher`;
mirrors `shared_users_client()`/`_cached_client()` in `users_client.py` exactly):

```python
from functools import lru_cache

import boto3

from src.shared.config.settings import get_settings
from src.shared.messaging.sqs_event_publisher import SqsEventPublisher


@lru_cache(maxsize=1)
def _cached_publisher(queue_url: str, endpoint_url: str | None, region: str) -> EventPublisher:
    """One publisher (hence one boto3 client) per process, keyed on primitives —
    same reasoning as `_cached_client()` in `users_client.py`: pydantic's
    `BaseSettings` is unhashable, so keying on `Settings` directly would raise
    `TypeError` on first call."""
    client = boto3.client("sqs", endpoint_url=endpoint_url, region_name=region)
    return SqsEventPublisher(client=client, queue_url=queue_url)


def shared_event_publisher() -> EventPublisher:
    """The process-wide Tracking event publisher, built lazily from settings.

    Lazy, not module-level, so importing this module does not construct a
    boto3 client (nor require a valid environment) — the same rule
    `shared_users_client()` follows.
    """
    settings = get_settings()
    return _cached_publisher(
        settings.events_queue_url,
        getattr(settings, "aws_endpoint_url", None),
        getattr(settings, "aws_region", "us-east-1"),
    )
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
cd services/tracking && pytest tests/shared/messaging/test_sqs_event_publisher.py
```

Expected: 2 passed.

- [ ] **Step 5: Write the failing test for `update_status.py`'s new emission**

Extend `services/tracking/tests/features/tracking/commands/test_update_status.py` (append; do
not rewrite the existing transition/guard tests):

```python
"""Extends the existing update_status test module with emission assertions."""

from src.features.tracking.commands.update_status import (
    UpdateTrackingStatusCommand,
    update_tracking_status,
)
from src.shared.audit.audit_actor import AuditActor


class FakeEventPublisher:
    """Records calls instead of emitting — the test double for this suite,
    NOT NoopEventPublisher (which discards silently and cannot be asserted on)."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def publish_tracking_status_changed(self, **kwargs) -> None:
        self.calls.append(kwargs)


def test_update_status_emits_tracking_status_changed_with_user_id_from_the_entity(
    session, existing_tracking,  # existing_tracking fixture already used by this test file
) -> None:
    publisher = FakeEventPublisher()
    command = UpdateTrackingStatusCommand(order_id=existing_tracking.order_id, status="ON_THE_WAY")

    update_tracking_status(session, command, publisher=publisher)

    assert len(publisher.calls) == 1
    call = publisher.calls[0]
    # user_id comes from the PERSISTED entity, never from a request param —
    # this test's fixture sets tracking.user_id to a DIFFERENT value than any
    # cognito_sub in scope, so it can only pass if the entity's field was used.
    assert call["user_id"] == existing_tracking.user_id
    assert call["order_id"] == existing_tracking.order_id
    assert call["status"] == "ON_THE_WAY"
    assert call["previous_status"] == "SHIPPED"


def test_update_status_emits_for_every_transition_including_delivered(
    session, existing_tracking_on_the_way,  # a fixture at ON_THE_WAY, if not already present
) -> None:
    publisher = FakeEventPublisher()
    command = UpdateTrackingStatusCommand(
        order_id=existing_tracking_on_the_way.order_id, status="OUT_FOR_DELIVERY"
    )
    update_tracking_status(session, command, publisher=publisher)

    command_final = UpdateTrackingStatusCommand(
        order_id=existing_tracking_on_the_way.order_id, status="DELIVERED"
    )
    update_tracking_status(session, command_final, publisher=publisher)

    statuses_emitted = [c["status"] for c in publisher.calls]
    assert statuses_emitted == ["OUT_FOR_DELIVERY", "DELIVERED"]  # no transition exempted


def test_event_id_stable_across_repeated_calls_for_the_same_transition(
    session, existing_tracking,
) -> None:
    """A retry of the SAME (order_id, status) must not mint a new event_id —
    Task 8's unique index is what dedupes it, but only if the id matches."""
    publisher = FakeEventPublisher()
    command = UpdateTrackingStatusCommand(order_id=existing_tracking.order_id, status="ON_THE_WAY")
    update_tracking_status(session, command, publisher=publisher)

    # The publisher itself (Step 3) is what derives event_id from
    # (order_id, status); this test only confirms update_status.py passes
    # order_id/status through unchanged so that derivation stays deterministic.
    assert publisher.calls[0]["order_id"] == existing_tracking.order_id
    assert publisher.calls[0]["status"] == "ON_THE_WAY"
```

- [ ] **Step 6: Run it, confirm the expected failure**

```bash
cd services/tracking && pytest tests/features/tracking/commands/test_update_status.py -k "emit or event_id"
```

Expected failure: `TypeError: update_tracking_status() got an unexpected keyword argument 'publisher'`.

- [ ] **Step 7: Minimal implementation — wire emission into `update_status.py`**

Modify `services/tracking/src/features/tracking/commands/update_status.py`:

```python
from src.shared.messaging.event_publisher import EventPublisher, NoopEventPublisher
from src.shared.messaging.sqs_event_publisher import shared_event_publisher  # noqa: F401  (re-exported for callers that want the default)
```

(Add these imports near the top, alongside the existing ones.)

Change the function signature to accept the port, defaulting to the real shared publisher so
existing callers (the carrier router) get real emission with no call-site change, while tests
inject a fake:

```python
def update_tracking_status(
    session: Session,
    command: UpdateTrackingStatusCommand,
    *,
    actor: AuditActor = AuditActor.CARRIER_STATUS_UPDATE,
    publisher: EventPublisher | None = None,
) -> Tracking:
    """...(existing docstring, plus:)

    ## Emission (events-pipeline milestone)

    After a successful transition, emits TRACKING_STATUS_CHANGED to the shared
    events queue. `user_id` for the envelope comes from `tracking.user_id` —
    the entity this function already loaded — NEVER from a request parameter,
    because the carrier webhook path (the majority caller) has no request-level
    identity at all (see the module docstring's "Why the lookup here is
    UNSCOPED"). `publisher` defaults to the real shared SQS publisher so
    production and the carrier/TestMode paths need no change; tests inject a
    fake or Noop explicitly (never test against the real one — see
    docs/lessons/mocks-hide-schema-bugs.md's spirit, applied in reverse: this
    is the one boundary tests SHOULD fake, since asserting against a live SQS
    send is the integration test's job below, not every unit test's).
    """
    requested: TrackingStatus = parse_status(command.status)

    repository = TrackingRepository(session)
    # user_id is NOT passed: unscoped by design — see the module docstring.
    tracking = repository.get_by_order_id(command.order_id)
    if tracking is None:
        raise TrackingNotFoundError(command.order_id)

    current = parse_status(tracking.status)
    assert_can_transition(current, requested)

    updated = repository.update_status(
        tracking=tracking,
        status=requested,
        actor=actor,
    )

    event_publisher = publisher if publisher is not None else shared_event_publisher()
    event_publisher.publish_tracking_status_changed(
        order_id=updated.order_id,
        user_id=updated.user_id,  # the persisted usr_ id — NOT a request param
        status=requested.value,
        previous_status=current.value,
        changed_at=updated.updated_at,
    )

    return updated
```

- [ ] **Step 8: Run test, confirm PASS**

```bash
cd services/tracking && pytest tests/features/tracking/commands/test_update_status.py
```

Expected: all existing tests still pass, plus the 3 new ones (emission with correct `user_id`,
all-four-transitions-emit including `DELIVERED`, stable `event_id` inputs).

- [ ] **Step 9: Wire `EVENTS_QUEUE_URL` into Tracking's generated env file**

In `infra/environments/local/scripts/generate_env_files.py`, add `"EVENTS_QUEUE_URL":
events_queue_url` (the same Terraform output Task 13 Step 9 already reads) to the dict literal
written for `.env.local.tracking` — find that service's existing dict and add this one key, per
[[env-files]]; do not restructure the surrounding dict or introduce a second way to read the
queue URL.

- [ ] **Step 10: Integration test — the message really lands on the shared queue**

`services/tracking/tests/shared/messaging/test_sqs_event_publisher_integration.py`:

```python
"""Layer 2 — real SQS against Floci, not mocked. Connects using the same
AWS_ENDPOINT_URL/region the service reads at runtime."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime

import boto3

from src.shared.config.settings import get_settings
from src.shared.messaging.sqs_event_publisher import SqsEventPublisher


def test_publish_lands_a_message_with_correct_attributes_on_the_real_queue() -> None:
    settings = get_settings()
    client = boto3.client(
        "sqs",
        endpoint_url=getattr(settings, "aws_endpoint_url", None),
        region_name=getattr(settings, "aws_region", "us-east-1"),
    )
    publisher = SqsEventPublisher(client=client, queue_url=settings.events_queue_url)

    marker_order_id = f"ord_e2e_{int(time.time())}"
    publisher.publish_tracking_status_changed(
        order_id=marker_order_id,
        user_id="usr_e2e_test1",
        status="SHIPPED",
        previous_status="null",
        changed_at=datetime.now(UTC),
    )

    # Poll — never a fixed sleep — measuring over 2-3x the expected delivery
    # period, per docs/lessons/verify-across-full-cycle.md.
    deadline = time.monotonic() + 15
    found = None
    while time.monotonic() < deadline and found is None:
        response = client.receive_message(
            QueueUrl=settings.events_queue_url,
            MessageAttributeNames=["All"],
            WaitTimeSeconds=2,
        )
        for message in response.get("Messages", []):
            body = json.loads(message["Body"])
            if body["order_id"] == marker_order_id:
                found = message
            # Not deleting non-matching messages — this test only inspects.
        time.sleep(0.5)

    assert found is not None, f"no message for {marker_order_id} landed on the queue within 15s"
    assert found["MessageAttributes"]["type"]["StringValue"] == "TRACKING_STATUS_CHANGED"
    assert found["MessageAttributes"]["source"]["StringValue"] == "tracking"
```

```bash
cd services/tracking && pytest tests/shared/messaging/test_sqs_event_publisher_integration.py
```

Expected: 1 passed (requires Block A's `messaging` module applied and reachable, and
`.env.local.tracking` regenerated with `EVENTS_QUEUE_URL` from Step 9).

- [ ] **Step 11: E2E — a real status change produces the email in Mailpit**

`services/tracking/tests/e2e/test_tracking_status_changed_email.py` (layer 3, the real path:
carrier webhook or TestMode → command → publisher → SQS → Lambda → DocumentDB → SES → Mailpit):

```python
"""E2E — the real path, gateway-through-Mailpit, per services/tracking/CLAUDE.md §2b
and the milestone design spec's "Tracking's own three layers" section."""

from __future__ import annotations

import time

import httpx

MAILPIT_API = "http://localhost:8025/api/v1"


def _poll_for_email(order_id: str, status: str, timeout_s: float = 30.0) -> dict:
    """Poll Mailpit for the email matching this order+status specifically —
    NOT an inbox-count assertion. A TestMode run emits FOUR emails for one
    tracking in ~30s (see the warning below), so asserting `count == 1` would
    be flaky-by-design; this polls for the ONE message whose subject names
    this status, tolerating the other three arriving before or after it."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        response = httpx.get(f"{MAILPIT_API}/search", params={"query": f'subject:"{order_id}" subject:"{status.lower()}"'})
        data = response.json()
        if data["messages"]:
            return data["messages"][0]
        time.sleep(1)
    raise TimeoutError(f"no email for order {order_id} status {status} within {timeout_s}s")


def test_carrier_status_update_produces_a_completed_document_and_an_email(
    carrier_client: httpx.Client,  # fixture: authenticated with TRACKING_CARRIER_API_KEY
    tracking_order_id: str,  # fixture: an order with a tracking already at SHIPPED
) -> None:
    response = carrier_client.put(
        f"/v1/trackings/{tracking_order_id}/status", json={"status": "ON_THE_WAY"}
    )
    assert response.status_code == 200

    message = _poll_for_email(tracking_order_id, "ON_THE_WAY")
    assert message is not None


def test_testmode_progression_produces_four_emails_one_per_status(
    testmode_tracking_order_id: str,  # fixture: init-tracking with test_mode=true, ~0s interval
) -> None:
    """Per the milestone design spec's warning: TestMode emits on every
    transition with no suppression, so one run produces FOUR emails for one
    tracking. Polling per-status (not an inbox count) is what makes this
    assertion reliable rather than a false negative/positive on ordering."""
    for status in ("SHIPPED", "ON_THE_WAY", "OUT_FOR_DELIVERY", "DELIVERED"):
        message = _poll_for_email(testmode_tracking_order_id, status, timeout_s=40.0)
        assert message is not None
```

```bash
cd services/tracking && pytest tests/e2e/test_tracking_status_changed_email.py -m e2e
```

Expected: 2 passed (requires the full local stack up: Block A applied, Block C's
`TRACKING_STATUS_CHANGED` handler live, Mailpit healthy, `E2E_TESTING_ENABLED=true`).

> [!warning] TestMode E2E produces four emails per run
> Because TestMode emits on every transition with no suppression (this task's implementation),
> a single TestMode E2E run that progresses a tracking through all four statuses produces
> **four emails in Mailpit for that one tracking**, not one. Assert by polling for each
> status's specific email (as `_poll_for_email` does above), never by asserting an inbox count
> of one — an inbox-count assertion here is a guaranteed false failure.

- [ ] **Step 12: Commit**

```bash
git add services/tracking/src/shared/messaging/ services/tracking/src/shared/config/settings.py services/tracking/src/features/tracking/commands/update_status.py services/tracking/tests/shared/messaging/ services/tracking/tests/features/tracking/commands/test_update_status.py services/tracking/tests/e2e/test_tracking_status_changed_email.py infra/environments/local/scripts/generate_env_files.py
git commit -m "feat(tracking): publish TRACKING_STATUS_CHANGED on every delivery-status transition"
```

---

## Reconciliation during implementation

Two artifacts describe a pre-Lambda world and must be fixed as part of this milestone, not left
for later:

1. **`docker-compose.yml`'s `events-pipeline` service** (build + `docker-watch`, no ports/DB/
   healthcheck — see the block originally at lines 288-313) no longer makes sense once the
   Lambda runs on Floci via Terraform (this plan's Block A + Block D). It is removed in Task 10
   (when Mailpit/preview server are added to the compose file) or, if not done there, finished
   in Task 13 Step 10. Do not leave it dangling alongside the real Lambda — a developer running
   `make up` should not see a phantom `events-pipeline` container that never receives traffic.
2. **`functions/events-pipeline/CLAUDE.md` §1** ("Local: a worker service via docker-watch") is
   corrected in Task 9 Step 5, once the Lambda entrypoint that supersedes the worker model
   exists. §2's "Run local" command is corrected in the same step.

## Propagation before the closing PR

Per [[doc-propagation]], before this milestone's closing PR is proposed, `obsidian-vault` must
update:

- **`docs/domains/events-pipeline/specs/events-pipeline-design.md`** — currently says handlers
  "validate and process" (no email) and lists the data model without `event_id`; both are now
  wrong. Update: handlers send email (validate → render → SES → COMPLETED, per Block C); add
  `event_id` as a new field with its own unique index, distinct from `friendlyId`, per Task 5/8.
  Also correct the producer count in the Summary to **three** (Users, Orders, Tracking) — not
  two — now that Task 14 lands Tracking's publisher. Bump `updated:` to this milestone's close
  date.
- **`docs/domains/tracking/specs/tracking-service-design.md`** — currently states Tracking is a
  pure consumer/updater that publishes no events; that is now false. Update it to document
  Tracking as the events-pipeline's third producer: `TRACKING_STATUS_CHANGED`, emitted from
  `update_tracking_status()` on every transition (including `DELIVERED`), sourced from
  `tracking.user_id` (never the request), `event_id` derived from `(order_id, status)`. Bump
  `updated:` to this milestone's close date. Link bidirectionally with the milestone spec (see
  the "Reversal — Tracking now publishes" callout in
  [[2026-08-03-events-pipeline-milestone-design]]).
- **`docs/00-overview/system-context.md`** — currently names two queues (`users-events`,
  `orders-events`); reconcile to the single shared queue this plan's Block A actually builds
  (`infra/modules/messaging/`, one `aws_sqs_queue.main` + DLQ), and show **three** producers
  (Users, Orders, Tracking) publishing to it, not two.
- **`docs/shared/conventions/testing.md`** — add events-pipeline's adapted three-layer mapping
  (unit / integration-against-Floci / real-Lambda-invoke E2E, since it has no HTTP endpoint) as
  a per-service guidance entry, mirroring the existing Orders/Users/Tracking bullets.
- **`docs/shared/conventions/env-files.md`** — add `.env.local.events-pipeline` to the files
  table (already anticipated in that note's "Adding a service" section, but not yet listed in
  the table itself) once Task 13 Step 9 lands, and confirm `.env.local.tracking`'s entry there
  notes its new `EVENTS_QUEUE_URL` key once Task 14 Step 9 lands.

This is what makes `propagates-to: ["[[events-pipeline-design]]", "[[testing]]",
"[[env-files]]", "[[tracking-service-design]]"]` on this plan's frontmatter true rather than
aspirational — the routing table in [[doc-propagation]] places "service behaviour/API/data
model" changes in the service spec, and this milestone changes exactly that (handlers now send
email; a new indexed field; Tracking gains a publisher it did not have before).

## Dependency gates

This milestone has four stop points, matching the four blocks — per the phase-C review flow,
chain issues within a block without per-merge prompts, but stop and batch PRs for review at
each gate. Block C now ends at Task 12 (`TRACKING_STATUS_CHANGED` joins `USER_CREATED`/
`ORDER_CREATED` as the third and final handler this milestone adds); Block D covers Tasks
13-14 (Task 13 wires Users/Orders, Task 14 wires Tracking):

1. **Block A → Block B.** Block B's Task 8 (Mongo repository integration test) and Task 9
   (handler, exercised against a real queue) cannot be verified without Block A's `messaging`
   and `database` modules applied on Floci. Tasks 1-3 can be authored and `terraform
   validate`-clean in parallel, but the batch stops here for review before Block B begins.
2. **Block B → Block C.** Task 10's `USER_CREATED` handler registers into the `HandlerMap` Task
   9 defines; Block C cannot be end-to-end verified (email landing in Mailpit via the real
   handler dispatch) until Block B's `handler.ts` and `process-record.ts` are merged.
3. **Block C → Block D.** Task 13's and Task 14's producers publish envelopes that only mean
   something once `USER_CREATED` (Task 10), `ORDER_CREATED` (Task 11), and
   `TRACKING_STATUS_CHANGED` (Task 12) handlers all exist — publishing to a queue with no
   matching handler would dead-end in `FAILED "Unknown event type"`. This is also why Task 14
   (Tracking) is sequenced after Task 12 within this same gate, even though Tracking's own code
   has no dependency on Users'/Orders' publishers (Task 13) — both Block D tasks depend on
   Block C being complete, not on each other.
4. **End of Block D.** The milestone's Definition of Done — Task 13 Step 11 (`POST
   /v1/users/register` → Mailpit) **and** Task 14 Step 11 (a tracking status change → Mailpit,
   including the four-emails-per-TestMode-run case) — is the final checkpoint. Batch the last
   PRs for review once both paths are verified.

## Related

- [[2026-08-03-events-pipeline-milestone-design]]
- [[floci-sqs-lambda-docdb-support]]
- [[testing]]
- [[env-files]]
- [[logging-context]]
- [[nano-id]]
- [[audit-fields]]
- [[cqrs]]
- [[tracking-service-design]]
