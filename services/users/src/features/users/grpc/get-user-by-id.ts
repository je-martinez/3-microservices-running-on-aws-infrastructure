import type { User } from "../domain/user.ts";
import type { UserQueryService } from "../queries/get-me.ts";

export interface GrpcDeps {
  userQueryService: Pick<UserQueryService, "getUserById">;
}

export async function getUserByIdHandler(
  deps: GrpcDeps,
  call: { request: { id: string } },
): Promise<{ user: User | null }> {
  const user = await deps.userQueryService.getUserById(call.request.id);
  return { user };
}
