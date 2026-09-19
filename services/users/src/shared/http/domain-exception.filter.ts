import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { AuthError } from "#shared/auth/auth-errors";
import { RecordNotFoundError } from "#shared/db/db-errors";
import { CascadeError } from "#shared/http/cascade-client";

// Maps this service's domain errors onto the HTTP contract the Fastify routes
// already serve (`{ error: <code> }` at the error's own status). Everything else
// falls through to Nest's own handling.
@Catch(AuthError, RecordNotFoundError, CascadeError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    if (error instanceof AuthError) {
      void reply.code(error.statusCode).send({ error: error.code });
      return;
    }
    if (error instanceof RecordNotFoundError) {
      void reply.code(error.statusCode).send({ error: error.code });
      return;
    }
    // A cascade leg did not confirm, so the account was deliberately NOT deleted.
    // 502 rather than 500: the failure is DOWNSTREAM and both internal routes are
    // idempotent, so the correct client action is to retry.
    void reply.code(502).send({ error: "cascade_failed" });
  }
}
