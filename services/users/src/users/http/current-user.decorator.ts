import {
  createParamDecorator,
  HttpException,
  HttpStatus,
  type ExecutionContext,
} from "@nestjs/common";
import type { RequestWithCurrentUser } from "./current-user.interceptor.ts";

// CONTRACT: One instance per request. CurrentUser caches its identity lookup
// internally, so a second instance re-queries the database on every handler
// that asks for it. `CurrentUserInterceptor` must run first. See
// [[user-id-vs-cognito-sub-ownership-key]]
export const CurrentUserParam = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<RequestWithCurrentUser>();
  if (!req.currentUser) {
    throw new HttpException({ error: "unauthenticated" }, HttpStatus.UNAUTHORIZED);
  }
  return req.currentUser;
});
