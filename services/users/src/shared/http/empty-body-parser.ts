import { errorCodes, type FastifyInstance } from "fastify";

// WORKAROUND(local): Floci's ALB forwards a bodyless DELETE as
// `transfer-encoding: chunked` with an empty body and no Content-Type, which
// Fastify rejects with 415 before the route runs (DELETE /v1/users/me fails).
// Do NOT widen this to accept a non-empty body or a Content-Type it does not
// know — those keep their 415. See [[2026-10-02-floci-preprod-environment-design]]
export function registerEmptyBodyParser(fastify: FastifyInstance): void {
  fastify.addContentTypeParser("*", { parseAs: "buffer" }, (request, body, done) => {
    if (request.headers["content-type"] === undefined && body.length === 0) {
      done(null, undefined);
      return;
    }
    done(new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE(), undefined);
  });
}
