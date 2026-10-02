import { Global, Module } from "@nestjs/common";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import { BusinessMetricsPoller } from "#shared/metrics/business-metrics";
import type { Db } from "#shared/db/prisma";
import { DB } from "#shared/tokens";
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
    {
      // CONTRACT: Constructed here, STARTED from main.ts — see the consumer there.
      provide: BusinessMetricsPoller,
      inject: [DB, MetricsPublisher, AppConfigService],
      useFactory: (db: Db, metricsPublisher: MetricsPublisher, config: AppConfigService) =>
        new BusinessMetricsPoller({
          db,
          metricsPublisher,
          env: { METRICS_INTERVAL_MS: config.get("METRICS_INTERVAL_MS") },
        }),
    },
  ],
  exports: [MetricsPublisher, BusinessMetricsPoller],
})
export class MetricsModule {}
