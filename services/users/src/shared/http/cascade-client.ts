import { appLogger } from "#shared/logging/app-logger";

// Base for every reason the cascade did not complete. The route maps this one
// type to 502, so a new failure mode gets the right status by subclassing rather
// than by touching the error handler.
export class CascadeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CascadeError";
  }
}

// Raised when a cascade leg does not confirm the delete. Carries WHICH service
// failed, so the 502 the user sees can be traced to a side without reading logs.
export class CascadeFailedError extends CascadeError {
  constructor(
    readonly service: "orders" | "tracking",
    readonly detail: string,
  ) {
    super(`${service} cascade failed: ${detail}`);
    this.name = "CascadeFailedError";
  }
}

// CONTRACT: A distinct type, not a CascadeFailedError with an arbitrary `service` —
// nothing downstream was called, so naming one puts a lie in the logs and the trace.
// Raised when the cascade cannot be ATTEMPTED (a user row with no `cognitoSub`). Still
// maps to 502: the deletion did not happen and the account is intact.
export class CascadeUnavailableError extends CascadeError {
  constructor(readonly reason: string) {
    super(`cascade not attempted: ${reason}`);
    this.name = "CascadeUnavailableError";
  }
}

export interface CascadeClientDeps {
  ordersBaseUrl: string;
  trackingBaseUrl: string;
  apiKey: string;
  // Injected so tests never touch the network. Defaults to global fetch (Node 24).
  fetchImpl?: typeof fetch;
}

// CONTRACT: Both routes this calls are INTERNAL — absent from the API Gateway,
// authenticated with the shared internal key, never a user JWT. The subject travels in
// the BODY, not an x-user-id header: this service acts on a user's behalf, so there is
// no end-user request on the far side to carry an identity header. Relative paths
// against a configured base URL, so no host is hardcoded.
// See [[ADR-0003-grpc-inter-service]]
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

  // CONTRACT: Send BOTH identities. `cognito_sub` is what Orders' reads filter by but
  // is not durable — a user who deletes and re-registers gets a NEW sub, while their
  // `usr_` id is stable — so matching either keeps a row with an empty or stale sub
  // reachable. camelCase on the wire, because Orders' DTOs are camelCase and this
  // client adapts to each service's own convention.
  async deleteOrdersForUser(cognitoSub: string, userId: string): Promise<void> {
    await this.send("orders", `${this.ordersBaseUrl}/v1/orders/by-user`, {
      cognitoSub,
      userId,
    });
  }

  // Tracking gets both identities for the same reason, plus one of its own: its
  // `cognito_sub` column is NULLABLE on rows predating migration b17f4c2e9a30,
  // and those rows are reachable only through `user_id`. snake_case, matching
  // that service's wire style.
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
    // Both downstream predicates match `cognito_sub OR user_id`. An empty value
    // on either side would turn that OR into a wider match than intended if a row
    // ever carried an empty string in the same column, so an empty identity never
    // leaves this client. The caller already refuses a missing sub; this is the
    // second gate, next to the request that would carry it.
    for (const [key, value] of Object.entries(body)) {
      if (!value) {
        throw new CascadeFailedError(service, `empty identity: ${key}`);
      }
    }

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
    } catch (err: any) {
      // A network failure and a 500 are the SAME fact to the caller: this leg did
      // not confirm, so the account must not be deleted. Both become one error.
      //
      // Logged as its own `*_failed` so the pair is queryable: an app_event that
      // only ever appears on success cannot answer the question it exists for.
      appLogger.error(
        { err, app_event: "cascade_delete_failed", cascade_service: service, reason: "unreachable" },
        "Cascade leg failed: the request never completed",
      );
      throw new CascadeFailedError(service, err?.message ?? "request failed");
    }

    if (!response.ok) {
      appLogger.error(
        {
          app_event: "cascade_delete_failed",
          cascade_service: service,
          reason: `status_${response.status}`,
        },
        "Cascade leg failed: the service refused the delete",
      );
      throw new CascadeFailedError(service, `status ${response.status}`);
    }

    appLogger.info({
      app_event: "cascade_delete_succeeded",
      cascade_service: service,
    });
  }
}
