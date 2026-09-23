import { Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppConfigService } from "#config/config.module";
import { appLogger } from "#shared/logging/app-logger";
import { isAllowedSource, parseAllowedSources, resolveClientIp } from "#shared/http/source-ip";
import { StripeUnavailableException } from "#shared/stripe/stripe-unavailable.exception";
import { urlTokenMatches } from "./webhook-url-token.ts";

export const STRIPE_WEBHOOK_ROUTE = "/v1/users/stripe/webhook/:token";

// CONTRACT: The source-IP allowlist and the URL token run in a Fastify
// `onRequest` hook, AFTER routing and BEFORE body parsing, keyed on
// `routeOptions.url`. Do NOT move them into a Nest middleware: its path regex
// runs on the raw URL, while Fastify also routes encoded variants
// (`/v1/users/%73tripe/webhook/x`) and an empty token (`/webhook/`) to the
// handler — both would skip the checks. Order: IP → token → signature (in the
// controller). See [[2026-09-19-stripe-payments-design]]
@Injectable()
export class StripeWebhookGate implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    // No HTTP adapter means no HTTP routes are served, the webhook included.
    const adapter = this.adapterHost.httpAdapter;
    if (!adapter) return;
    adapter.getInstance<FastifyInstance>().addHook("onRequest", async (request, reply) => {
      if (request.method !== "POST" || request.routeOptions.url !== STRIPE_WEBHOOK_ROUTE) return;
      return this.check(request, reply);
    });
  }

  private check(request: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
    const cidrs = this.config.get("STRIPE_WEBHOOK_ALLOWED_CIDRS", { infer: true });
    if (!cidrs) return this.reject(reply, new StripeUnavailableException());

    const hops = this.config.get("STRIPE_WEBHOOK_TRUSTED_PROXY_HOPS", { infer: true }) ?? 0;
    const sourceIp = resolveClientIp(
      request.raw.socket.remoteAddress,
      request.headers["x-forwarded-for"],
      hops,
    );
    if (sourceIp === undefined || !isAllowedSource(sourceIp, parseAllowedSources(cidrs))) {
      appLogger.warn(
        {
          app_event: "stripe_webhook_received",
          reason: "source_ip_not_allowed",
          ...(sourceIp === undefined ? {} : { source_ip: sourceIp }),
        },
        "Stripe webhook rejected: source IP not in the allowlist",
      );
      return reply.code(403).send({ error: "forbidden_source" });
    }

    const expected = this.config.get("STRIPE_WEBHOOK_URL_TOKEN", { infer: true });
    if (!expected) return this.reject(reply, new StripeUnavailableException());

    const { token } = request.params as { token?: string };
    if (!urlTokenMatches(token, expected)) {
      // CONTRACT: Answer exactly what Nest answers for an unmapped route, and
      // log nothing — a distinct body or status lets a scanner confirm the
      // route exists. See [[2026-09-19-stripe-payments-design]]
      return this.reject(reply, new NotFoundException(`Cannot ${request.method} ${request.raw.url}`));
    }
    return undefined;
  }

  private reject(reply: FastifyReply, error: StripeUnavailableException | NotFoundException): FastifyReply {
    return reply.code(error.getStatus()).send(error.getResponse());
  }
}
