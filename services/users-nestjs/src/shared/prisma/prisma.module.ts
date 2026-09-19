import { Global, Module } from "@nestjs/common";
import { AppConfigService } from "#config/config.module";
import { createPrismaClient, type Db } from "#shared/db/prisma";
import { DB } from "#shared/tokens";

// CONTRACT: One shared client for the process. The composed extensions (nano-id
// + audit + soft-delete + read-replica routing) are built once by
// createPrismaClient; a second client would open its own pool and lose
// read-your-writes routing. See [[soft-delete]]
@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Db =>
        createPrismaClient({
          DATABASE_WRITER_URL: config.get("DATABASE_WRITER_URL"),
          DATABASE_READER_URL: config.get("DATABASE_READER_URL"),
        }),
    },
  ],
  exports: [DB],
})
export class PrismaModule {}
