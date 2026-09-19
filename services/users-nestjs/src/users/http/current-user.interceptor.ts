import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import type { FastifyRequest } from "fastify";
import { CurrentUser } from "#shared/auth/current-user";
import type { Db } from "#shared/db/prisma";
import { DB } from "#shared/tokens";

export type RequestWithCurrentUser = FastifyRequest & { currentUser?: CurrentUser };

// CONTRACT: One CurrentUser per request, attached on the Fastify request object.
// Nest middleware receives Node's IncomingMessage under Fastify, so an interceptor
// (not middleware) is what can stamp fields the param decorator later reads.
// See [[user-id-vs-cognito-sub-ownership-key]]
@Injectable()
export class CurrentUserInterceptor implements NestInterceptor {
  constructor(@Inject(DB) private readonly db: Db) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestWithCurrentUser>();
    const identity = req.headers["x-user-id"];
    if (typeof identity === "string" && identity.length > 0) {
      req.currentUser ??= new CurrentUser({ db: this.db, identity });
    }
    return next.handle();
  }
}
