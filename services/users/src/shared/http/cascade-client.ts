import { appLogger } from "#shared/logging/app-logger";

// Raised when a cascade leg does not confirm the delete. Carries WHICH service
// failed, so the 502 the user sees can be traced to a side without reading logs.
export class CascadeFailedError extends Error {
  constructor(
    readonly service: "orders" | "tracking",
    readonly detail: string,
  ) {
    super(`${service} cascade failed: ${detail}`);
    this.name = "CascadeFailedError";
  }
}

export interface CascadeClientDeps {
  ordersBaseUrl: string;
  trackingBaseUrl: string;
  apiKey: string;
  // Injected so tests never touch the network. Defaults to global fetch (Node 24).
  fetchImpl?: typeof fetch;
}

// The first plain-HTTP outbound client in this service: every other outbound call
// Users makes is gRPC, an AWS SDK client, or Redis.
//
// Shaped after Orders' TrackingHttpClient, so this is not a new pattern in the
// repo — only a new one here: relative paths against a configured base URL, so no
// host is ever hardcoded.
//
// Both routes it calls are INTERNAL. They are absent from the API Gateway and
// authenticate with the shared internal key (ADR-0003), never a user JWT. The
// subject travels in the BODY rather than an x-user-id header, because the caller
// is this service acting on a user's behalf — there is no end-user request on the
// far side to carry an identity header.
export class CascadeClient {
  private readonly ordersBaseUrl: string;
  private readonly trackingBaseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor({ ordersBaseUrl, trackingBaseUrl, apiKey, fetchImpl }: CascadeClientDeps) {
    this.ordersBaseUrl = ordersBaseUrl;
    this.trackingBaseUrl = trackingBaseUrl;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  // camelCase on the wire: Orders' DTOs are camelCase, and the client adapts to
  // each service's own convention rather than imposing one across two runtimes.
  async deleteOrdersForUser(cognitoSub: string): Promise<void> {
    await this.send("orders", `${this.ordersBaseUrl}/v1/orders/by-user`, {
      cognitoSub,
    });
  }

  // Tracking gets BOTH identities. Its `cognito_sub` column is nullable on rows
  // predating migration b17f4c2e9a30, and those rows are reachable only through
  // `user_id` — sending one identity would silently strand a returning user's
  // oldest tracking data. snake_case, matching that service's wire style.
  async deleteTrackingsForUser(cognitoSub: string, userId: string): Promise<void> {
    await this.send("tracking", `${this.trackingBaseUrl}/v1/trackings/by-user`, {
      cognito_sub: cognitoSub,
      user_id: userId,
    });
  }

  private async send(
    service: "orders" | "tracking",
    url: string,
    body: Record<string, string>,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          // NEVER logged, here or downstream — not the value, not a prefix.
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      // A network failure and a 500 are the SAME fact to the caller: this leg did
      // not confirm, so the account must not be deleted. Both become one error.
      throw new CascadeFailedError(service, e?.message ?? "request failed");
    }

    if (!response.ok) {
      throw new CascadeFailedError(service, `status ${response.status}`);
    }

    appLogger.info({
      app_event: "cascade_delete_succeeded",
      cascade_service: service,
    });
  }
}
