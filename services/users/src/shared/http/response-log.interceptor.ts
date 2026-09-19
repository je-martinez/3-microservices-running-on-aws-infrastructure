import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Observable, tap } from "rxjs";
import { withHttpServerSpan } from "#shared/observability/request-span";
import { MetricsPublisher } from "#shared/metrics/cloudwatch-metrics";

const HEALTH_ROUTE = "/v1/health";

@Injectable()
export class ResponseLogInterceptor implements NestInterceptor {
  constructor(private readonly metricsPublisher: MetricsPublisher) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const startedAt = process.hrtime.bigint();

    return next.handle().pipe(
      tap({
        next: () => this.emit(req, reply, startedAt),
        error: () => this.emit(req, reply, startedAt),
      }),
    );
  }

  private emit(req: FastifyRequest, reply: FastifyReply, startedAt: bigint): void {
    const route = req.routeOptions?.url ?? req.url;
    const status = reply.statusCode;

    // CONTRACT: Exempt the liveness probe by STATUS, never by route. A succeeding
    // probe logs nothing; a FAILING one must still log. Suppressing the route
    // instead hides the failures. See [[health-check-logging]]
    const isHealthySoak = route === HEALTH_ROUTE && status >= 200 && status < 300;

    if (!isHealthySoak) {
      // CONTRACT: Log with the HTTP SERVER span active, not the ambient hook span,
      // or the line is stamped with the wrong span_id and OpenObserve's "View
      // logs" on the request span returns NOTHING. See [[logging-context]]
      withHttpServerSpan(req, () => {
        req.log.info(
          {
            http_request_method: req.method,
            http_route: route,
            http_response_status_code: status,
            duration_ms: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
            // CONTRACT: Do NOT add `trace_id: req.id`. The real OTel ids come from
            // logger.ts's formatter, and an explicit field beats the ambient one —
            // Fastify's local counter would break the logs↔traces join.
            // See [[logging-context]]
          },
          "request completed",
        );
      });
    }

    // ONLY 4xx/5xx. A metric per 2xx would be a request-rate metric, which the
    // log line above already provides.
    if (status >= 400) {
      // CONTRACT: Keep this guarded and unawaited. Awaiting would hold the
      // connection open for a PutMetricData round trip; publish() never rejects.
      try {
        void this.metricsPublisher.publish("http_errors_total", 1, {
          Service: "users",
          StatusClass: status >= 500 ? "5xx" : "4xx",
        });
      } catch {
        // Intentionally silent — see above.
      }
    }
  }
}
