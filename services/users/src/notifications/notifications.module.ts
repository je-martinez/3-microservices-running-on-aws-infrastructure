import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { AppConfigService } from "#config/config.module";
import { createPublishToUser } from "#shared/realtime/websocket-publisher";
import { PUBLISH_TO_USER } from "#shared/tokens";
import { CurrentUserInterceptor } from "../users/http/current-user.interceptor.ts";
import { CreateNotificationHandler } from "./commands/create-notification.command.ts";
import { MarkNotificationsReadHandler } from "./commands/mark-notifications-read.command.ts";
import { NotificationsController } from "./http/notifications.controller.ts";
import { NotificationConsumerService } from "./messaging/notification-consumer.service.ts";
import { ListNotificationsHandler } from "./queries/list-notifications.query.ts";

@Module({
  imports: [CqrsModule],
  controllers: [NotificationsController],
  providers: [
    {
      provide: PUBLISH_TO_USER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        createPublishToUser({
          AWS_REGION: config.get("AWS_REGION"),
          AWS_ENDPOINT_URL: config.get("AWS_ENDPOINT_URL"),
          WS_CONNECTIONS_TABLE: config.get("WS_CONNECTIONS_TABLE"),
          WS_CONNECTIONS_GSI: config.get("WS_CONNECTIONS_GSI"),
          WS_MANAGEMENT_ENDPOINT: config.get("WS_MANAGEMENT_ENDPOINT"),
        }),
    },
    CreateNotificationHandler,
    MarkNotificationsReadHandler,
    ListNotificationsHandler,
    NotificationConsumerService,
    CurrentUserInterceptor,
  ],
  exports: [NotificationConsumerService],
})
export class NotificationsModule {}
