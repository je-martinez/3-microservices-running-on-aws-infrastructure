// CONTRACT: the ONLY importer of @nxavis/aws-icons. Swapping the icon source touches this file alone. See [[diagrams]]
import {
  AmazonApiGateway, AmazonAurora, AmazonCloudWatch, AmazonCognito, AmazonDocumentDb, AmazonDynamoDb,
  AmazonElastiCache, AmazonElasticContainerRegistry, AmazonElasticContainerService, AmazonEventBridge,
  AmazonRds, AmazonSimpleEmailService, AmazonSimpleNotificationService, AmazonSimpleQueueService,
  AmazonSimpleStorageService, AmazonVirtualPrivateCloud, AwsFargate, AwsIdentityAndAccessManagement,
  AwsLambda, AwsSecretsManager, AwsSystemsManager, ElasticLoadBalancing,
} from "@nxavis/aws-icons";
import type { ComponentType } from "react";
import type { AwsService } from "../schema";

const ICONS: Record<AwsService, ComponentType<{ size?: number }>> = {
  "api-gateway": AmazonApiGateway, aurora: AmazonAurora, rds: AmazonRds, cognito: AmazonCognito,
  documentdb: AmazonDocumentDb, dynamodb: AmazonDynamoDb, elasticache: AmazonElastiCache,
  eventbridge: AmazonEventBridge, sqs: AmazonSimpleQueueService, sns: AmazonSimpleNotificationService,
  ses: AmazonSimpleEmailService, s3: AmazonSimpleStorageService, ecr: AmazonElasticContainerRegistry,
  ecs: AmazonElasticContainerService, fargate: AwsFargate, elb: ElasticLoadBalancing, lambda: AwsLambda,
  cloudwatch: AmazonCloudWatch, "secrets-manager": AwsSecretsManager, ssm: AwsSystemsManager,
  iam: AwsIdentityAndAccessManagement, vpc: AmazonVirtualPrivateCloud,
};

export function awsIcon(service: AwsService): ComponentType<{ size?: number }> {
  return ICONS[service];
}
