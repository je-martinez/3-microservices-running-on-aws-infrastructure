import { SetMetadata } from "@nestjs/common";

/** Reflector metadata key for routes that do not require `x-user-id`. */
export const IS_PUBLIC_KEY = "isPublic";

/**
 * Marks a handler (or controller) as reachable without an identity header.
 * AuthGuard reads this via Reflector — public routes declare themselves rather
 * than living in a hand-rolled (method, path) allowlist.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
