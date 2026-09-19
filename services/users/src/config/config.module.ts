import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { envSchema, type Env } from "./env.schema.ts";

// CONTRACT: Inject this type, never ConfigService — design:paramtypes resolves the
// concrete class, and ConfigService<Env, true> is what makes get() non-optional.
// Registered via useExisting so Nest's ConfigService instance is the runtime value.
export class AppConfigService extends ConfigService<Env, true> {}

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envSchema,
      cache: true,
    }),
  ],
  providers: [
    {
      provide: AppConfigService,
      useExisting: ConfigService,
    },
  ],
  exports: [AppConfigService],
})
export class AppConfigModule {}
