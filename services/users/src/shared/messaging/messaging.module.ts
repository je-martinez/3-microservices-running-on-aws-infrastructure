import { Global, Module } from "@nestjs/common";
import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import { SnsEventPublisher } from "#shared/messaging/event-publisher";
import { AppConfigService } from "#config/config.module";
import { EVENT_PUBLISHER } from "#shared/tokens";

export const SQS_CLIENT = Symbol.for("users:sqsClient");
const SNS_CLIENT = Symbol.for("users:snsClient");

@Global()
@Module({
  providers: [
    {
      provide: SNS_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new SNSClient({ region: config.get("AWS_REGION"), endpoint: config.get("AWS_ENDPOINT_URL") }),
    },
    {
      // Publishing goes to the topic; this client stays because the
      // notifications consumer receives from a queue.
      provide: SQS_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new SQSClient({ region: config.get("AWS_REGION"), endpoint: config.get("AWS_ENDPOINT_URL") }),
    },
    {
      provide: EVENT_PUBLISHER,
      inject: [SNS_CLIENT, AppConfigService],
      useFactory: (sns: SNSClient, config: AppConfigService) =>
        new SnsEventPublisher(sns, config.get("EVENTS_TOPIC_ARN")),
    },
  ],
  exports: [EVENT_PUBLISHER, SQS_CLIENT],
})
export class MessagingModule {}
