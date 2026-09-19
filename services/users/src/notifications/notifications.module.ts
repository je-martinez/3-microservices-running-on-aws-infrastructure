import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { publishToUser } from "#shared/realtime/websocket-publisher";
import { CurrentUserInterceptor } from "../users/http/current-user.interceptor.ts";
import {
  CreateNotificationHandler,
  PUBLISH_TO_USER,
} from "./commands/create-notification.command.ts";
import { MarkNotificationsReadHandler } from "./commands/mark-notifications-read.command.ts";
import { NotificationsController } from "./http/notifications.controller.ts";
import { NotificationConsumerService } from "./messaging/notification-consumer.service.ts";
import { ListNotificationsHandler } from "./queries/list-notifications.query.ts";

@Module({
  imports: [CqrsModule],
  controllers: [NotificationsController],
  providers: [
    { provide: PUBLISH_TO_USER, useValue: publishToUser },
    CreateNotificationHandler,
    MarkNotificationsReadHandler,
    ListNotificationsHandler,
    NotificationConsumerService,
    CurrentUserInterceptor,
  ],
  exports: [NotificationConsumerService],
})
export class NotificationsModule {}
