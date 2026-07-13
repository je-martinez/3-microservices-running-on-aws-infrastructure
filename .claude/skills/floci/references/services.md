# Floci services — per-service knowledge layer

Every Floci service with its official doc URL. **3MRAI** column marks services the project
uses (auth chain, services, events pipeline, infra). **Notes** captures verified quirks or
troubleshooting; where empty, the official page is the source.

Base URL pattern: `https://floci.io/floci/services/<slug>/`

Full verified quirks with evidence: [[floci-vs-ministack-spike-findings]].

## Used by 3MRAI

| Service | Doc | 3MRAI use | Notes / troubleshooting |
|---|---|---|---|
| Cognito | [cognito](https://floci.io/floci/services/cognito/) | Users auth (JWT) | `iss` = `http://localhost:4566/<pool-id>`; `user_pool_client` returns empty `AnalyticsConfiguration` → `ignore_changes`; **Lambda triggers stored but never invoked**. |
| API Gateway (v1/v2) | [api-gateway](https://floci.io/floci/services/api-gateway/) | HTTP API + JWT authorizer | Invoke via `restapis/<id>/$default/_user_request_/<path>` (LocalStack-style), NOT `<id>.execute-api.localhost`. HTTP_PROXY works. |
| ECS | [ecs](https://floci.io/floci/services/ecs/) | Nginx reverse proxy task | Real Docker containers via `FLOCI_SERVICES_ECS_DOCKER_NETWORK`; task **recreated each apply** (new IP) → use stable Docker alias. `FLOCI_SERVICES_ECS_MOCK` for CI. |
| Lambda | [lambda](https://floci.io/floci/services/lambda/) | events-pipeline; EventBridge targets | Runs as real Docker containers; direct `invoke` works; logs to CloudWatch Logs. |
| EventBridge | [eventbridge](https://floci.io/floci/services/eventbridge/) | Domain events (UserRegistered) | **Delivers to Lambda/SQS targets (verified).** Use as the capture path since Cognito triggers don't fire. |
| SQS | [sqs](https://floci.io/floci/services/sqs/) | events-pipeline queue | — |
| IAM | [iam](https://floci.io/floci/services/iam/) | ECS exec / Lambda roles | Roles accepted; emulator does not enforce them. |
| STS | [sts](https://floci.io/floci/services/sts/) | provider account id | `get-caller-identity` → account `000000000000`. |
| Secrets Manager | [secrets-manager](https://floci.io/floci/services/secrets-manager/) | DB credentials (ADR-0007) | — |
| SSM (Parameter Store) | [ssm](https://floci.io/floci/services/ssm/) | params (ADR-0007) | — |
| CloudWatch | [cloudwatch](https://floci.io/floci/services/cloudwatch/) | Lambda logs / metrics | Lambda logs land in `/aws/lambda/<fn>`. |
| RDS | [rds](https://floci.io/floci/services/rds/) | Aurora Postgres/MySQL | Runs real DB containers; no writer→reader replication locally (point reader at writer). |
| DocumentDB | [docdb](https://floci.io/floci/services/docdb/) | events-pipeline store | Real container-backed. |
| ELBv2 | [elb](https://floci.io/floci/services/elb/) | (prod ALB; local uses Nginx) | Docs document instance targets; `ip` target not confirmed — local uses Nginx ECS proxy instead. |
| Route53 | [route53](https://floci.io/floci/services/route53/) | (not used locally) | **Management-plane only — no DNS resolution.** Do not use for local service discovery. |
| Cloud Map (servicediscovery) | [cloudmap](https://floci.io/floci/services/cloudmap/) | (attempted, dropped) | API exists but ECS tasks not registered + names not propagated to Docker DNS → not viable. Use Docker alias. |
| ECR | [ecr](https://floci.io/floci/services/ecr/) | images (prod) | Container-backed. |
| S3 | [s3](https://floci.io/floci/services/s3/) | assets / state | Note: unknown `:4566` paths fall through to the S3 handler (`NoSuchBucket`) — explains odd API GW 404s. |

## Other available services (reference)

Not currently used by 3MRAI; listed for discovery. Pattern: `https://floci.io/floci/services/<slug>/`.

| Service | slug | Service | slug |
|---|---|---|---|
| SNS | `sns` | SES | `ses` |
| DynamoDB | `dynamodb` | KMS | `kms` |
| Kinesis | `kinesis` | Firehose | `firehose` |
| Step Functions | `step-functions` | CloudFormation | `cloudformation` |
| ACM | `acm` | ElastiCache | `elasticache` |
| MemoryDB | `memorydb` | RDS Data | `rds-data` |
| MSK | `msk` | Glue | `glue` |
| Neptune | `neptune` | Athena | `athena` |
| Pipes | `pipes` | Scheduler | `scheduler` |
| EKS | `eks` | OpenSearch | `opensearch` |
| EC2 | `ec2` | AppConfig | `appconfig` |
| Bedrock Runtime | `bedrock-runtime` | Autoscaling | `autoscaling` |
| Elastic Beanstalk | `elastic-beanstalk` | CodeBuild | `codebuild` |
| Batch | `batch` | CodeDeploy | `codedeploy` |
| CodePipeline | `codepipeline` | Backup | `backup` |
| CloudFront | `cloudfront` | Resource Groups Tagging | `resource-groups-tagging` |
| Transfer | `transfer` | Config | `config` |
| CloudTrail | `cloudtrail` | EMR | `emr` |
| WAFv2 | `wafv2` | Textract | `textract` |
| Transcribe | `transcribe` | Pricing | `pricing` |
| Cost Explorer | `ce` | CUR | `cur` |
| BCM Data Exports | `bcm-data-exports` | AppSync | `appsync` |
| IoT | `iot` | | |

## Related

- [[floci-vs-ministack-spike-findings]] — full verified findings + comparison table.
- Spike reference implementation: `infra/environments/local/spike-floci/`.
