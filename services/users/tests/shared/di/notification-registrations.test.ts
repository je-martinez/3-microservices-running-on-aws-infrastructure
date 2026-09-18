/**
 * Resolves the notification registrations THROUGH the real Awilix container.
 *
 * CONTRACT: Resolve from the real container here. The unit suites build these
 * classes directly with hand-built doubles, which never exercises the
 * registration — and an Awilix wiring mistake is a RESOLUTION-time failure, so
 * typecheck, lint and a fully green unit suite all pass while the service dies on
 * boot. See [[mocks-hide-schema-bugs]]
 */
import { describe, it, expect, beforeAll } from "vitest";
import { diContainer } from "@fastify/awilix";
import { registerSingletons, registerServices } from "#shared/di/awilix-container";
import { CreateNotificationCommand } from "#features/notifications/commands/create-notification";
import { NotificationConsumer } from "#features/notifications/messaging/notification-consumer";
import { NotificationQueryService } from "#features/notifications/queries/list-notifications";
import { MarkNotificationsReadCommand } from "#features/notifications/commands/mark-notifications-read";

describe("notification DI registrations", () => {
  beforeAll(() => {
    registerSingletons();
    registerServices();
  });

  it("resolves createNotificationCommand from the container", () => {
    expect(diContainer.resolve("createNotificationCommand")).toBeInstanceOf(
      CreateNotificationCommand,
    );
  });

  it("resolves notificationConsumer, whose chain reaches the command and the SQS client", () => {
    // The whole chain: notificationConsumer -> createNotificationCommand -> db,
    // plus sqsClient and env. Resolving the consumer walks all of it, which is
    // what `server.ts` does on boot.
    expect(diContainer.resolve("notificationConsumer")).toBeInstanceOf(NotificationConsumer);
  });

  it("returns the same consumer twice — it is SINGLETON", () => {
    // Not a style assertion: a second NotificationConsumer would own a second
    // long-poll loop competing with the first for the same queue.
    expect(diContainer.resolve("notificationConsumer")).toBe(
      diContainer.resolve("notificationConsumer"),
    );
  });

  it("resolves the two use cases behind the three HTTP routes", () => {
    expect(diContainer.resolve("notificationQueryService")).toBeInstanceOf(
      NotificationQueryService,
    );
    expect(diContainer.resolve("markNotificationsReadCommand")).toBeInstanceOf(
      MarkNotificationsReadCommand,
    );
  });

  it("gives each request scope its own instance of the read pair — they are SCOPED", () => {
    const scope = diContainer.createScope();
    const other = diContainer.createScope();

    expect(scope.resolve("notificationQueryService")).not.toBe(
      other.resolve("notificationQueryService"),
    );
    expect(scope.resolve("markNotificationsReadCommand")).not.toBe(
      other.resolve("markNotificationsReadCommand"),
    );
  });
});
