import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionStore } from '../auth/session-store';
import type { User } from '../api/types';
import { ApiError, type ApiErrorBody } from '../http/api-client';
import { RumErrorHandler } from './rum-error-handler';

const SIGNED_IN_USER: User = {
  id: 'usr_V1StGXR8Z5',
  email: 'shopper@example.com',
  fullName: 'Signed In Shopper',
  address: null,
  phoneNumber: null,
  tags: [],
  authType: 'PASSWORD',
  mustChangePassword: false,
  createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedBy: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedBy: null,
  deletedAt: null,
  isDeleted: false,
};

/**
 * CONTRACT: RumErrorHandler is `@Injectable()` without `providedIn: 'root'`
 * (app.config.ts registers it via `useClass` against the ErrorHandler
 * token), so TestBed needs it listed explicitly to resolve it at all.
 */
function createHandler(): RumErrorHandler {
  TestBed.configureTestingModule({ providers: [RumErrorHandler] });
  return TestBed.inject(RumErrorHandler);
}

describe('RumErrorHandler', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('delegates every error to the original console handler', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createHandler();

    handler.handleError(new Error('boom'));

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('emits only status and detail for an ApiError, never the body', () => {
    const handler = createHandler();
    const emitSpy = vi.spyOn(
      handler as unknown as { emit: (record: unknown) => void },
      'emit',
    );
    // WHY: `requestBody` is not a key ApiErrorBody declares — a real gateway
    // error body can still carry one, and this asserts the handler drops any
    // key it does not explicitly allow-list, not just the ones it knows about.
    const error = new ApiError(
      422,
      {
        detail: 'email already registered',
        requestBody: { email: 'a@b.com', password: 'secret' },
      } as ApiErrorBody,
      'Unprocessable Entity',
    );

    handler.handleError(error);

    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 422, detail: 'email already registered' }),
    );
    const emitted = emitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(emitted['body']).toBeUndefined();
    expect(emitted['requestBody']).toBeUndefined();
    expect(JSON.stringify(emitted)).not.toContain('secret');
  });

  it('emits message, stack and type for a plain Error, and omits unknown fields rather than nulling them', () => {
    const handler = createHandler();
    const emitSpy = vi.spyOn(
      handler as unknown as { emit: (record: unknown) => void },
      'emit',
    );

    handler.handleError(new TypeError('cannot read x of undefined'));

    const emitted = emitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(emitted['message']).toBe('cannot read x of undefined');
    expect(emitted['type']).toBe('TypeError');
    expect('cognito_sub' in emitted).toBe(false);
  });

  it('emits trace_id when the ApiError carries one, stamped by the propagation interceptor', () => {
    const handler = createHandler();
    const emitSpy = vi.spyOn(
      handler as unknown as { emit: (record: unknown) => void },
      'emit',
    );
    const error = new ApiError(500, null, 'Internal Server Error');
    error.traceId = '4bf92f3577b34da6a3ce929d0e0e4736';

    handler.handleError(error);

    const emitted = emitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(emitted['trace_id']).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('omits trace_id entirely for an ordinary Error, which has no active span to attribute it to', () => {
    const handler = createHandler();
    const emitSpy = vi.spyOn(
      handler as unknown as { emit: (record: unknown) => void },
      'emit',
    );

    handler.handleError(new Error('template error'));

    const emitted = emitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('trace_id' in emitted).toBe(false);
  });

  it('strips the query string from an ApiError message, keeping the rest', () => {
    const handler = createHandler();
    const emitSpy = vi.spyOn(
      handler as unknown as { emit: (record: unknown) => void },
      'emit',
    );
    const error = new ApiError(
      401,
      null,
      'Http failure response for http://localhost:4200/v1/orders?email=shopper@example.com&token=abc123: 401 Unauthorized',
    );

    handler.handleError(error);

    const emitted = emitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(emitted['message']).toBe(
      'Http failure response for http://localhost:4200/v1/orders: 401 Unauthorized',
    );
    expect(emitted['message']).not.toContain('?');
    expect(emitted['message']).not.toContain('email=');
  });

  it('emits user_id when a session exists, read only from SessionStore', () => {
    const handler = createHandler();
    // WHY: toRecord() reads the signal fresh on every handleError() call, so
    // setting state on the same TestBed injector after construction still
    // reaches it — there is no snapshot taken at construction time to go stale.
    TestBed.inject(SessionStore).setUser(SIGNED_IN_USER);
    const emitSpy = vi.spyOn(
      handler as unknown as { emit: (record: unknown) => void },
      'emit',
    );

    handler.handleError(new Error('boom'));

    const emitted = emitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(emitted['user_id']).toBe('usr_V1StGXR8Z5');
  });

  // WHY: cognito_sub has no synchronous source in this app (see toRecord's
  // CONTRACT) — this asserts that deliberate limitation, not an oversight.
  it('omits both user_id and cognito_sub when nobody is signed in', () => {
    const handler = createHandler();
    const emitSpy = vi.spyOn(
      handler as unknown as { emit: (record: unknown) => void },
      'emit',
    );

    handler.handleError(new Error('boom'));

    const emitted = emitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('user_id' in emitted).toBe(false);
    expect('cognito_sub' in emitted).toBe(false);
  });

  it('never emits the signed-in user email, even while a session is active', () => {
    const handler = createHandler();
    TestBed.inject(SessionStore).setUser(SIGNED_IN_USER);
    const emitSpy = vi.spyOn(
      handler as unknown as { emit: (record: unknown) => void },
      'emit',
    );

    handler.handleError(new Error('boom'));

    const emitted = emitSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(emitted)).not.toContain('shopper@example.com');
  });
});
