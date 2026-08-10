# Floci services — canonical map

**Source of truth: <https://floci.io/floci/services/>.** Every row below is generated
from that index — do not add a service, rename one, or invent a slug that is not on it.
If a service you need is missing here, **open the index and check** rather than guessing
a URL: a plausible-looking slug that 404s is worse than no link.

Every page follows `https://floci.io/floci/services/<slug>/`.

**Read the target service's page — including its own Docker Compose section — before
concluding it is unsupported.** ElastiCache was written off as broken here until that
page turned out to document a proxy port range we had simply never published (quirk 14).

`3MRAI use` marks what the project actually uses. `Notes` carries quirks verified in this
repo; where it is `—`, the official page is the source. Full evidence:
[[floci-vs-ministack-spike-findings]].

Services on the index: **70**.

## Used by 3MRAI

| Service | Doc | 3MRAI use | Notes / troubleshooting |
|---|---|---|---|
| SSM Parameter Store | [`ssm`](https://floci.io/floci/services/ssm/) | params (ADR-0007) | — |
| SQS | [`sqs`](https://floci.io/floci/services/sqs/) | events-pipeline queue | **Solid (verified 2026-08-03):** visibility timeout, `ApproximateReceiveCount`, **automatic DLQ redrive**, and partial batch responses all behave like real AWS. See quirk 12. |
| SES | [`ses`](https://floci.io/floci/services/ses/) | transactional email | Stores mail locally regardless of the SMTP relay; 3MRAI relays to Mailpit for inspection. |
| S3 | [`s3`](https://floci.io/floci/services/s3/) | assets / tfstate | Unknown `:4566` paths fall through to the S3 handler (`NoSuchBucket`) — explains odd API GW 404s. |
| DynamoDB | [`dynamodb`](https://floci.io/floci/services/dynamodb/) | WebSocket connection registry | — |
| Lambda | [`lambda`](https://floci.io/floci/services/lambda/) | events-pipeline; Cognito + EventBridge targets | Runs as real Docker containers; direct `invoke` works; logs to CloudWatch Logs. |
| API Gateway | [`api-gateway`](https://floci.io/floci/services/api-gateway/) | HTTP API + JWT authorizer | Invoke via `restapis/<id>/$default/_user_request_/<path>` (LocalStack-style), NOT `<id>.execute-api.localhost`. HTTP_PROXY works. |
| Cognito | [`cognito`](https://floci.io/floci/services/cognito/) | Users auth (JWT) | `iss` = `http://localhost:4566/<pool-id>`; `user_pool_client` returns empty `AnalyticsConfiguration` → `ignore_changes`. **Trigger support is SPLIT** — `CUSTOM_AUTH` challenge triggers fire; sign-up **and `CustomMessage`** triggers do not (quirk 7). |
| Secrets Manager | [`secrets-manager`](https://floci.io/floci/services/secrets-manager/) | DB credentials (ADR-0007) | — |
| IAM | [`iam`](https://floci.io/floci/services/iam/) | ECS exec / Lambda roles | Roles accepted; emulator does not enforce them. |
| STS | [`sts`](https://floci.io/floci/services/sts/) | provider account id | `get-caller-identity` → account `000000000000`. |
| ElastiCache | [`elasticache`](https://floci.io/floci/services/elasticache/) | Users password-reset codes (10-min TTL) | **Real `valkey/valkey:8` container** (`floci-valkey-<replication-group-id>`); native TTL works. Must be a **replication group**, not a cache cluster. **Publish `6379-6399`** or `localhost:6379` is closed. **AWS provider 5.31.0 CRASHES** on the native resource. See quirk 14. |
| RDS | [`rds`](https://floci.io/floci/services/rds/) | Aurora Postgres/MySQL | Real DB containers; no writer→reader replication locally (point reader at writer). Proxy ports **7000-7099 assigned by creation order — NOT deterministic**; discover per engine. See quirk 11. |
| DocumentDB | [`docdb`](https://floci.io/floci/services/docdb/) | events-pipeline store | Real `mongo:7.0`, **standalone with no replica set** → no multi-document transactions locally. Not listed by `rds describe-db-clusters`; 27017 not published — connect by container name. See quirk 12. |
| EventBridge | [`eventbridge`](https://floci.io/floci/services/eventbridge/) | Domain events | **Delivers to Lambda/SQS targets (verified).** |
| CloudWatch | [`cloudwatch`](https://floci.io/floci/services/cloudwatch/) | Lambda logs / metrics | Lambda logs land in `/aws/lambda/<fn>`. |
| ECS | [`ecs`](https://floci.io/floci/services/ecs/) | Nginx reverse proxy task | Real Docker containers via `FLOCI_SERVICES_ECS_DOCKER_NETWORK`; task **recreated each apply** (new IP) → use a stable Docker alias. `FLOCI_SERVICES_ECS_MOCK` for CI. |
| ECR | [`ecr`](https://floci.io/floci/services/ecr/) | images (prod) | Container-backed. |
| ELB v2 | [`elb`](https://floci.io/floci/services/elb/) | (prod ALB; local uses Nginx) | Docs document instance targets; `ip` target not confirmed — local uses the Nginx ECS proxy instead. |
| CloudFront | [`cloudfront`](https://floci.io/floci/services/cloudfront/) | (evaluated, dropped) | **Management-plane only** — *"actual content delivery is not emulated"*. No local invoke URL. See quirk 13. |
| Route53 | [`route53`](https://floci.io/floci/services/route53/) | (not used locally) | **Management-plane only — no DNS resolution.** Do not use for local service discovery (quirk 6). |
| AWS Cloud Map | [`cloudmap`](https://floci.io/floci/services/cloudmap/) | (attempted, dropped) | API exists but ECS tasks are not registered and names do not reach Docker DNS → not viable. Use a Docker alias (quirk 6). |

## Everything else on the index

Not used by 3MRAI today. Listed so the slug is never guessed.

| Service | Doc | Service | Doc |
|---|---|---|---|
| SNS | [`sns`](https://floci.io/floci/services/sns/) | KMS | [`kms`](https://floci.io/floci/services/kms/) |
| Kinesis | [`kinesis`](https://floci.io/floci/services/kinesis/) | Managed Service for Apache Flink | [`kinesisanalytics`](https://floci.io/floci/services/kinesisanalytics/) |
| CloudFormation | [`cloudformation`](https://floci.io/floci/services/cloudformation/) | Step Functions | [`step-functions`](https://floci.io/floci/services/step-functions/) |
| MemoryDB | [`memorydb`](https://floci.io/floci/services/memorydb/) | RDS Data API | [`rds-data`](https://floci.io/floci/services/rds-data/) |
| MSK (Kafka) | [`msk`](https://floci.io/floci/services/msk/) | Glue | [`glue`](https://floci.io/floci/services/glue/) |
| Neptune | [`neptune`](https://floci.io/floci/services/neptune/) | Athena | [`athena`](https://floci.io/floci/services/athena/) |
| Data Firehose | [`firehose`](https://floci.io/floci/services/firehose/) | EventBridge Pipes | [`pipes`](https://floci.io/floci/services/pipes/) |
| EventBridge Scheduler | [`scheduler`](https://floci.io/floci/services/scheduler/) | CloudWatch RUM | [`rum`](https://floci.io/floci/services/rum/) |
| ACM | [`acm`](https://floci.io/floci/services/acm/) | Resource Groups Tagging API | [`resource-groups-tagging`](https://floci.io/floci/services/resource-groups-tagging/) |
| EKS | [`eks`](https://floci.io/floci/services/eks/) | MWAA | [`mwaa`](https://floci.io/floci/services/mwaa/) |
| OpenSearch | [`opensearch`](https://floci.io/floci/services/opensearch/) | EC2 | [`ec2`](https://floci.io/floci/services/ec2/) |
| Lightsail | [`lightsail`](https://floci.io/floci/services/lightsail/) | AppConfig | [`appconfig`](https://floci.io/floci/services/appconfig/) |
| Bedrock Runtime | [`bedrock-runtime`](https://floci.io/floci/services/bedrock-runtime/) | Auto Scaling | [`autoscaling`](https://floci.io/floci/services/autoscaling/) |
| Elastic Beanstalk | [`elastic-beanstalk`](https://floci.io/floci/services/elastic-beanstalk/) | CodeBuild | [`codebuild`](https://floci.io/floci/services/codebuild/) |
| AWS Batch | [`batch`](https://floci.io/floci/services/batch/) | CodeDeploy | [`codedeploy`](https://floci.io/floci/services/codedeploy/) |
| CodePipeline | [`codepipeline`](https://floci.io/floci/services/codepipeline/) | AWS Backup | [`backup`](https://floci.io/floci/services/backup/) |
| CloudTrail | [`cloudtrail`](https://floci.io/floci/services/cloudtrail/) | AWS IoT Core | [`iot`](https://floci.io/floci/services/iot/) |
| AppSync | [`appsync`](https://floci.io/floci/services/appsync/) | Transfer Family | [`transfer`](https://floci.io/floci/services/transfer/) |
| AWS Config | [`config`](https://floci.io/floci/services/config/) | EMR | [`emr`](https://floci.io/floci/services/emr/) |
| WAF v2 | [`wafv2`](https://floci.io/floci/services/wafv2/) | Textract | [`textract`](https://floci.io/floci/services/textract/) |
| Transcribe | [`transcribe`](https://floci.io/floci/services/transcribe/) | Pricing | [`pricing`](https://floci.io/floci/services/pricing/) |
| Cost Explorer | [`ce`](https://floci.io/floci/services/ce/) | Cost and Usage Reports | [`cur`](https://floci.io/floci/services/cur/) |
| BCM Data Exports | [`bcm-data-exports`](https://floci.io/floci/services/bcm-data-exports/) | Amazon MQ | [`amazonmq`](https://floci.io/floci/services/amazonmq/) |
| Application Auto Scaling | [`applicationautoscaling`](https://floci.io/floci/services/applicationautoscaling/) | S3 Vectors | [`s3vectors`](https://floci.io/floci/services/s3vectors/) |

## Related

- [[floci-vs-ministack-spike-findings]] — full verified findings + comparison table.
- Spike reference implementation: `infra/environments/local/spike-floci/`.
