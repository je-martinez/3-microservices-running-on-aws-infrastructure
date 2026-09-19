import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { IS_PUBLIC_KEY } from "./public.decorator.ts";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const actor = request.headers["x-user-id"];
    if (typeof actor !== "string" || actor.length === 0) {
      // CONTRACT: Exact Fastify-era body — `{ error: "unauthenticated" }` at 401.
      // Do NOT use UnauthorizedException's default envelope.
      throw new HttpException({ error: "unauthenticated" }, HttpStatus.UNAUTHORIZED);
    }
    return true;
  }
}
