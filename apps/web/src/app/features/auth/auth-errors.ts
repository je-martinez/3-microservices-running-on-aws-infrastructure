import { ApiError } from '../../core/http/api-client';

const OFFLINE = 'We could not reach the server. Check your connection and try again.';
const UNEXPECTED = 'Something went wrong. Please try again.';

/**
 * Turns a thrown value into the sentence an auth screen renders.
 *
 * CONTRACT: Read `ApiError.detail`, never `body.error` directly — Fastify's
 * validation body puts the useless status label ("Bad Request") in `error` and
 * the field-level text in `message`, so a screen reading `error` tells the user
 * nothing about what they typed wrong. `detail` already resolves all four error
 * shapes this stack serves. See [[2026-09-04-web-gateway-integration-design]]
 */
export function authErrorMessage(error: unknown, byStatus: Record<number, string> = {}): string {
  if (!(error instanceof ApiError)) return UNEXPECTED;
  // Status 0 is a transport failure: `detail` there is a browser string like
  // "Http failure response for /v1/users/login: 0 Unknown Error".
  if (error.status === 0) return OFFLINE;
  return byStatus[error.status] ?? error.detail;
}

/** Shared copy for the one status every credential-checking call can answer. */
export const WRONG_CREDENTIALS = 'That email and password do not match an account.';
