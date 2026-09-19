import { Global, Module } from "@nestjs/common";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import { AppConfigService } from "#config/config.module";

const CLOUDWATCH_CLIENT = Symbol.for("users:cloudwatchClient");

@Global()
@Module({
  providers: [
    {
      provide: CLOUDWATCH_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new CloudWatchClient({
          region: config.get("AWS_REGION"),
          endpoint: config.get("AWS_ENDPOINT_URL"),
        }),
    },
    {
      // WHY: A factory, not useClass. The constructor takes `{ client }` while
      // the provider it comes from is the CloudWatch client token — useClass
      // would fail at bootstrap, not in any unit test.
      // See [[dependency-injection]]
      provide: MetricsPublisher,
      inject: [CLOUDWATCH_CLIENT],
      useFactory: (client: CloudWatchClient) => new MetricsPublisher({ client }),
    },
  ],
  exports: [MetricsPublisher],
})
export class MetricsModule {}
