import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AppConfigService } from "#config/config.module";
import { actorContext } from "#shared/audit/actor-context";
import { logContext } from "#shared/logging/log-context";
import { REQUEST_ID_HEADER, resolveRequestId } from "#shared/logging/request-id";
import { RUN_ID_HEADER, resolveRunId } from "#shared/logging/run-id";

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly config: AppConfigService) {}

  // CONTRACT: Call `next()` from INSIDE the actorContext.run callback. The rest of
  // the request continues off that call, so a `next()` outside it leaves every
  // later frame without the store and the Prisma audit extension writes a null
  // actor. See [[audit-fields]]
  use(req: IncomingMessage, _res: ServerResponse, next: () => void): void {
    const rawActor = req.headers["x-user-id"];
    const actor = typeof rawActor === "string" ? rawActor : undefined;

    // CONTRACT: Attach the request id BEFORE any auth rejection, which returns
    // instead of continuing the chain. Without enterWith here every 401 ships
    // with no correlation id. See [[2026-08-15-request-id-correlation-design]]
    const request_id = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    // CONTRACT: `run_id` is E2E-only and caller-controlled — without
    // E2E_TESTING_ENABLED the header must behave as if never sent. Omit it when
    // absent, never blank: an empty run_id attributes a fixture to a run that
    // does not exist. See [[logging-context]]
    const run_id = resolveRunId(
      req.headers[RUN_ID_HEADER],
      this.config.get("E2E_TESTING_ENABLED", { infer: true }),
    );
    logContext.enterWith({ request_id, ...(run_id ? { run_id } : {}) });

    // Seed both ALS stores; unknown fields are OMITTED, never null.
    actorContext.run({ actor }, () => {
      logContext.run(
        {
          request_id,
          ...(actor === undefined ? {} : { cognito_sub: actor }),
          ...(run_id ? { run_id } : {}),
        },
        next,
      );
    });
  }
}
