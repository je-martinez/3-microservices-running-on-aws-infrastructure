import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  type OnApplicationBootstrap,
  type Type,
} from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { firstValueFrom, from, type Observable } from "rxjs";
import { appLogger, hasLoggedEvent } from "#shared/logging/app-logger";
import { RoutineFailure, WORKFLOW_FLOW } from "./workflow-metadata.ts";

const tracer = trace.getTracer("users-workflow");

const EXECUTE_WRAPPED = Symbol.for("users:workflowExecuteWrapped");

// CommandBus handlers return promises; Nest hands the interceptor an Observable.
// Unwrapping to the first value keeps the `await` semantics the handlers expect.
function firstValue(source: Observable<unknown>): Promise<unknown> {
  return firstValueFrom(source);
}

// Reads the reason a handler stamped on its own span. `setAttributes` is
// last-write-wins per key, so this is what stands between a generic catch and a
// destroyed `invalid_credentials`/`passwordless_user`/`cognito_error`.
function recordedReason(span: Span): string | undefined {
  const attributes = (span as unknown as { attributes?: Record<string, unknown> }).attributes;
  const reason = attributes?.reason;
  return typeof reason === "string" ? reason : undefined;
}

// Minimal ExecutionContext so intercept() can read @Workflow metadata off the
// handler class. @nestjs/cqrs CommandBus calls instance.execute directly and
// never builds a Nest ExecutionContext for handlers.
class CqrsHandlerContext implements ExecutionContext {
  constructor(private readonly handlerClass: Type<unknown>) {}

  getClass<T = unknown>(): Type<T> {
    return this.handlerClass as Type<T>;
  }

  getHandler(): Function {
    return this.handlerClass.prototype.execute;
  }

  getArgs<T extends unknown[] = unknown[]>(): T {
    return [] as unknown as T;
  }

  getArgByIndex<T = unknown>(_index: number): T {
    return undefined as T;
  }

  switchToRpc(): ReturnType<ExecutionContext["switchToRpc"]> {
    // CONTRACT: The bus is not an RPC transport. A caller reaching for the
    // payload here has the wrong context, and failing loudly beats handing back
    // an empty object it will dereference.
    throw new Error("CqrsHandlerContext carries no RPC arguments");
  }

  switchToHttp(): ReturnType<ExecutionContext["switchToHttp"]> {
    // CONTRACT: The bus is not an HTTP transport. A caller reaching for the
    // request here has the wrong context, and failing loudly beats handing back
    // an empty object it will dereference.
    throw new Error("CqrsHandlerContext carries no HTTP arguments");
  }

  switchToWs(): ReturnType<ExecutionContext["switchToWs"]> {
    // CONTRACT: The bus is not a WebSocket transport. A caller reaching for the
    // client here has the wrong context, and failing loudly beats handing back
    // an empty object it will dereference.
    throw new Error("CqrsHandlerContext carries no WS arguments");
  }

  getType<TContext extends string = string>(): TContext {
    return "cqrs_handler" as TContext;
  }
}

@Injectable()
export class WorkflowInterceptor implements NestInterceptor, OnApplicationBootstrap {
  constructor(private readonly modulesContainer: ModulesContainer) {}

  // WHY: @nestjs/cqrs 12's CommandBus.bind stores `(cmd) => instance.execute(cmd)`
  // and never runs APP_INTERCEPTOR. Wrapping execute on @Workflow handlers after
  // bootstrap is what makes bus.execute go through this interceptor. See the
  // composition note in [[2026-09-19-users-nestjs-migration-design]].
  onApplicationBootstrap(): void {
    for (const nestModule of this.modulesContainer.values()) {
      for (const wrapper of nestModule.providers.values()) {
        const instance = wrapper.instance as { execute?: Function; [key: symbol]: unknown } | undefined;
        const metatype = wrapper.metatype as Type<unknown> | undefined;
        if (!instance || !metatype || typeof instance.execute !== "function") continue;
        if (!Reflect.getMetadata(WORKFLOW_FLOW, metatype)) continue;
        if (instance[EXECUTE_WRAPPED]) continue;

        const original = instance.execute.bind(instance);
        const self = this;
        instance.execute = function workflowWrappedExecute(command: unknown) {
          const context = new CqrsHandlerContext(metatype);
          return firstValue(
            self.intercept(context, {
              handle: () => from((async () => original(command))()),
            }),
          );
        };
        instance[EXECUTE_WRAPPED] = true;
      }
    }
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const flow = Reflect.getMetadata(WORKFLOW_FLOW, context.getClass()) as string | undefined;
    // Untagged handlers pass straight through: a flow name is opt-in, and a
    // guessed one would invent `app_event` values no dashboard filters on.
    if (!flow) return next.handle();

    return from(this.run(flow, next));
  }

  private async run(flow: string, next: CallHandler): Promise<unknown> {
    return tracer.startActiveSpan(
      flow,
      { kind: SpanKind.INTERNAL, attributes: { app_event: `${flow}_started` } },
      async (span) => {
        try {
          const result = await firstValue(next.handle());

          // CONTRACT: A routine failure is a RETURNED value, not a throw — it
          // logs `_failed` + reason with span status left OK. See the class
          // comment on RoutineFailure.
          if (result instanceof RoutineFailure) {
            // CONTRACT: Defer to a reason the handler already recorded — same
            // last-write-wins rule as the thrown branch. See [[logging-context]]
            const reason = recordedReason(span) ?? result.reason;
            span.setAttributes({ app_event: `${flow}_failed`, reason });
            this.logFailureOnce(span, flow, reason);
            return result.value;
          }

          span.setAttributes({ app_event: `${flow}_succeeded` });
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          // CONTRACT: Defer to a reason the handler already recorded. Stamping
          // unconditionally overwrites `invalid_credentials`, `passwordless_user`,
          // `cognito_error`, `invalid_otp` and `unknown_user`. See [[logging-context]]
          const reason = recordedReason(span) ?? "unhandled_error";
          span.setAttributes({ app_event: `${flow}_failed`, reason });
          this.logFailureOnce(span, flow, reason, err);
          throw err;
        } finally {
          // CONTRACT: end() in a finally — a span left open on the exception path
          // is never exported and vanishes from the cascade without erroring.
          span.end();
        }
      },
    );
  }

  // CONTRACT: One failure, one `*_failed` line. A handler that already logged its
  // own specific line has said everything this one would; logging anyway doubles
  // every failure in the stream.
  private logFailureOnce(span: Span, flow: string, reason: string, err?: unknown): void {
    if (hasLoggedEvent(span, `${flow}_failed`)) return;
    appLogger.error({ ...(err ? { err } : {}), app_event: `${flow}_failed`, reason }, `${flow} failed`);
  }
}
