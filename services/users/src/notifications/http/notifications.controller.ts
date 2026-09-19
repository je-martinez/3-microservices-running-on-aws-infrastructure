import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Patch,
  Query,
  UseInterceptors,
} from "@nestjs/common";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import type { CurrentUser } from "#shared/auth/current-user";
import { ZodValidationPipe } from "#shared/http/zod-validation.pipe";
import {
  MarkReadInputSchema,
  NotificationFilterQuerySchema,
} from "#features/notifications/http/schemas";
import { CurrentUserParam } from "../../users/http/current-user.decorator.ts";
import { CurrentUserInterceptor } from "../../users/http/current-user.interceptor.ts";
import { serializeNotification } from "../../users/http/serializers.ts";
import { MarkNotificationsReadCommand } from "../commands/mark-notifications-read.command.ts";
import {
  ListNotificationsQuery,
  type NotificationFilter,
  type NotificationsPage,
} from "../queries/list-notifications.query.ts";

// CONTRACT: `user_id` comes from the JWT via the x-user-id header, NEVER from a
// parameter or body — a caller-supplied id would read anyone's inbox. Do NOT
// mark any of these three @Public(): that absence is what makes AuthGuard 401
// a request with no identity. See [[2026-09-10-in-app-notifications-design]]
@Controller("v1/notifications")
@UseInterceptors(CurrentUserInterceptor)
export class NotificationsController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Get()
  async list(
    @CurrentUserParam() currentUser: CurrentUser,
    @Query(new ZodValidationPipe(NotificationFilterQuerySchema))
    query: { filter: NotificationFilter },
  ) {
    const page = (await this.queryBus.execute(
      new ListNotificationsQuery(currentUser, query.filter),
    )) as NotificationsPage;
    return {
      items: page.items.map(serializeNotification),
      unread_count: page.unread_count,
      window_total: page.window_total,
      window_days: page.window_days,
    };
  }

  // Separate from the list so the bell badge costs one COUNT rather than a full
  // page fetch — the panel polls this, the list is read on open.
  @Get("unread-count")
  async unreadCount(@CurrentUserParam() currentUser: CurrentUser) {
    const page = (await this.queryBus.execute(
      new ListNotificationsQuery(currentUser, "all"),
    )) as NotificationsPage;
    return { unread_count: page.unread_count };
  }

  // CONTRACT: A LIST of ids, which is why there is no separate read-all route —
  // one endpoint covers entering the All screen, "Mark all as read", and marking
  // a single one. An empty list answers 200 with updated: 0, never 400.
  @Patch("read")
  async markRead(
    @CurrentUserParam() currentUser: CurrentUser,
    @Body(new ZodValidationPipe(MarkReadInputSchema)) body: { ids: string[] },
  ) {
    const result = (await this.commandBus.execute(
      new MarkNotificationsReadCommand(currentUser, body),
    )) as { updated: number; unread_count: number };

    // Only the SINGLE-id case 404s. Several ids are a bulk operation where some
    // already being read is routine, so a zero there is a normal 200.
    if (body.ids.length === 1 && result.updated === 0) {
      throw new NotFoundException({ error: "not_found" });
    }
    return result;
  }
}
