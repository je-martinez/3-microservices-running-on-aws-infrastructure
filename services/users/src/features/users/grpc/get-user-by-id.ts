import { appLogger } from "#shared/logging/app-logger";
import { withGrpcServerSpan } from "#shared/observability/grpc-tracing";
import type { User } from "../domain/user.ts";
import type { UserQueryService } from "../queries/get-me.ts";

export interface GrpcDeps {
  userQueryService: Pick<UserQueryService, "getUserById">;
}

export async function getUserByIdHandler(
  deps: GrpcDeps,
  call: { request: { id: string } },
): Promise<{ user: User | null }> {
  // Wrapped explicitly rather than left to auto-instrumentation: the server
  // interceptor consumes the metadata, so the instrumentation sees nothing and
  // creates no server span. The caller's context is extracted in that same
  // interceptor and is already active here.
  // See shared/observability/grpc-tracing.ts.
  return withGrpcServerSpan("users.v1.Users/GetUserById", async () => {
    // Logged from INSIDE the span so both lines carry its span_id. This is the
    // service's only gRPC surface and it produced no log line at all: an
    // inbound lookup from Tracking left no trace in the log stream, so "did
    // Users answer, and with what?" was unanswerable without reading Jaeger.
    //
    // The request id is a `usr_` id OR a Cognito sub — neither is PII and the
    // resolver accepts both, so it is logged as given rather than guessed at.
    const user = await deps.userQueryService.getUserById(call.request.id);

    // A miss is a routine outcome (the server maps it to NOT_FOUND), not a
    // thrown error, so the span status stays OK and the two outcomes are told
    // apart by `app_event`/`reason` — the same treatment get_profile's span
    // already gives its own 404 branch.
    if (user) {
      appLogger.info(
        { app_event: "get_user_by_id_succeeded", user_id: user.id },
        "gRPC GetUserById resolved",
      );
    } else {
      appLogger.info(
        { app_event: "get_user_by_id_failed", reason: "user_not_found" },
        "gRPC GetUserById found no user",
      );
    }

    return { user };
  });
}
