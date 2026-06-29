import type { User } from "../domain/user.js";

export interface GrpcDeps {
  getUserById: (deps: unknown, id: string) => Promise<User | null>;
}

export async function getUserByIdHandler(
  deps: GrpcDeps,
  call: { request: { id: string } },
): Promise<{ user: User | null }> {
  const user = await deps.getUserById(deps, call.request.id);
  return { user };
}
