import { ErrorHandler, Injectable, inject } from '@angular/core';
import { SeverityNumber } from '@opentelemetry/api-logs';

import { SessionStore } from '../auth/session-store';
import { ApiError } from '../http/api-client';
import { getRumLoggerProvider } from './rum';

interface RumErrorRecord {
  message: string;
  type: string;
  stack?: string;
  route: string;
  trace_id?: string;
  status?: number;
  detail?: string;
  user_id?: string;
}

/**
 * CONTRACT: Angular's HttpErrorResponse.message embeds the full request URL,
 * query string included. Strips only that URL's query portion.
 */
function stripQueryString(message: string): string {
  return message.replace(/^(Http failure response for [^\s?]+)\?[^\s:]*/, '$1');
}

/**
 * CONTRACT: Delegates to the original handler AFTER reporting, always — a
 * handler that swallows an error is worse than none.
 */
/**
 * CONTRACT: Redaction is bounded up front. Sent fields are exactly message,
 * stack, type, route, trace_id, user_id, and — for an ApiError —
 * status/detail. NEVER the full error object, a request body, a query
 * string, or a plaintext email. Unknown fields are OMITTED, never null.
 * See [[logging-context]], [[2026-09-19-web-rum-integration-design]]
 */
@Injectable()
export class RumErrorHandler implements ErrorHandler {
  private readonly sessionStore = inject(SessionStore);

  handleError(error: unknown): void {
    this.emit(this.toRecord(error));
    console.error(error);
  }

  /**
   * CONTRACT: trace_id is present only for a gateway-call ApiError, stamped
   * by rum-propagation-interceptor before its span context unwinds. Every
   * other error has no active span by the time ErrorHandler runs.
   */
  /**
   * CONTRACT: user_id is SessionStore's synchronous `User.id` (`usr_…`),
   * present only with a session. cognito_sub is NEVER emitted — no
   * synchronous source exists. `email` is never read off User. Both
   * omitted, never null. See [[logging-context]]
   */
  private toRecord(error: unknown): RumErrorRecord {
    const user = this.sessionStore.user();
    const base = {
      route: typeof location !== 'undefined' ? location.pathname : '',
      ...(user ? { user_id: user.id } : {}),
    };

    if (error instanceof ApiError) {
      return {
        ...base,
        ...(error.traceId ? { trace_id: error.traceId } : {}),
        message: stripQueryString(error.message),
        type: 'ApiError',
        status: error.status,
        detail: error.detail,
      };
    }

    if (error instanceof Error) {
      return {
        ...base,
        message: error.message,
        type: error.name,
        stack: error.stack,
      };
    }

    return { ...base, message: String(error), type: 'UnknownError' };
  }

  private emit(record: RumErrorRecord): void {
    const provider = getRumLoggerProvider();
    if (!provider) return;

    const logger = provider.getLogger('3mrai-web-errors');
    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: record.message,
      attributes: { ...record },
    });
  }
}
