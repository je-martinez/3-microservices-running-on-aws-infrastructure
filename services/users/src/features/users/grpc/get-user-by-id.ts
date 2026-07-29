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
    const user = await deps.userQueryService.getUserById(call.request.id);
    return { user };
  });
}
