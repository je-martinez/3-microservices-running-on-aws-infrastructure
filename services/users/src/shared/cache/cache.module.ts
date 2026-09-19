import { Global, Module } from "@nestjs/common";
import { createRedisClient, type RedisClient } from "#shared/cache/redis";
import { ResetCodeStore } from "#shared/cache/reset-code-store";
import { CacheGateway } from "#shared/cache/cache-gateway";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";
import { AppConfigService } from "#config/config.module";
import { envSchema } from "#config/env.schema";
import { REDIS } from "#shared/tokens";

// CONTRACT: One ioredis client for the process. It owns a real TCP socket and
// its own reconnect state machine, so a second instance leaks a connection and
// a second reconnect loop.
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        createRedisClient({ host: config.get("REDIS_HOST"), port: config.get("REDIS_PORT") }),
    },
    {
      provide: ResetCodeStore,
      inject: [REDIS],
      useFactory: (redis: RedisClient) => new ResetCodeStore({ redis }),
    },
    {
      // CacheGateway reads only CACHE_ENABLED off the env object, but its
      // constructor takes the whole validated Env — hand it the parsed config
      // rather than a hand-built partial, so a field added later is already there.
      provide: CacheGateway,
      inject: [REDIS, MetricsPublisher, AppConfigService],
      useFactory: (
        redis: RedisClient,
        metricsPublisher: MetricsPublisher,
        config: AppConfigService,
      ) => new CacheGateway({ redis, metricsPublisher, env: envSchema.parse(process.env) }),
    },
  ],
  exports: [REDIS, ResetCodeStore, CacheGateway],
})
export class CacheModule {}
