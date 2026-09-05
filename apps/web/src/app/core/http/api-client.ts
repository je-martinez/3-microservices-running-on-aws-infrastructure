import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';

import { APP_CONFIG } from '../config/app-config';

/**
 * Union of every error body this stack serves, verified live at localhost:3004:
 * gateway `{message}`, Users `{error}`, Fastify validation
 * `{statusCode, code, error, message}`, Tracking `{detail, reason}`. Orders
 * declares no error schema at all, so nothing generated pins its shape.
 */
export interface ApiErrorBody {
  error?: string;
  message?: string;
  detail?: string | unknown;
  reason?: string;
  code?: string;
  statusCode?: number;
}

const ERROR_BODY_KEYS = ['error', 'message', 'detail', 'reason', 'code', 'statusCode'] as const;

/**
 * CONTRACT: Require a known key, do NOT accept any non-null object. On a
 * transport failure `HttpErrorResponse.error` is a ProgressEvent, which passes
 * a bare object check and would surface as `body` — a caller then reads
 * `body.message` off a DOM event and gets undefined instead of null.
 */
function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  return ERROR_BODY_KEYS.some((key) => key in value);
}

/**
 * CONTRACT: Every failed ApiClient call rejects with THIS; do NOT let a raw
 * HttpErrorResponse escape. A caller testing `err.status === 401` compiles
 * against either, but on the raw one `err.error` is an untyped blob whose shape
 * differs per service, so the branch silently reads undefined.
 */
export class ApiError extends Error {
  /** 0 when the request never got a response (offline, DNS, aborted). */
  readonly status: number;
  /** Parsed body when the service sent JSON; null for a transport failure or non-JSON. */
  readonly body: ApiErrorBody | null;

  constructor(status: number, body: ApiErrorBody | null, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /**
   * WHY: The four services disagree on which key holds the human-readable text,
   * so every caller wanting to show something would otherwise repeat this
   * fallback chain.
   */
  get detail(): string {
    const body = this.body;
    if (!body) return this.message;
    // CONTRACT: Read `message` FIRST on a Fastify validation body. There `error`
    // holds the useless status label ("Bad Request") while the field-level text
    // ("body/email Invalid email address") is in `message` — preferring `error`
    // shows the user nothing about what they typed wrong. Verified live against
    // POST /v1/users/login. See [[2026-09-04-web-gateway-integration-design]]
    if (typeof body.code === 'string' && typeof body.message === 'string') return body.message;
    if (typeof body.error === 'string') return body.error;
    if (typeof body.message === 'string') return body.message;
    if (typeof body.detail === 'string') return body.detail;
    return this.message;
  }
}

function toApiError(response: HttpErrorResponse): ApiError {
  const body: unknown = response.error;
  return new ApiError(
    response.status,
    isApiErrorBody(body) ? body : null,
    response.message || `HTTP ${String(response.status)}`,
  );
}

/** Options a caller may pass through; the URL and error mapping are ours. */
export interface ApiRequestOptions {
  params?: HttpParams | Record<string, string | number | boolean | readonly string[]>;
  headers?: HttpHeaders | Record<string, string | string[]>;
}

/**
 * CONTRACT: Every gateway call goes through this wrapper, never HttpClient
 * directly — that is what guarantees the APP_CONFIG prefix and the ApiError
 * mapping. It is deliberately thin: no retry, no cache, no request queue.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);

  /**
   * CONTRACT: `path` is service-relative and starts with a slash
   * ("/users/me"), never the "/v1" prefix — APP_CONFIG.apiGatewayUrl supplies
   * that. Passing "/v1/users/me" yields a request to "/v1/v1/users/me", which
   * the gateway answers with its own 404 rather than the service's.
   */
  private url(path: string): string {
    return `${APP_CONFIG.apiGatewayUrl}${path}`;
  }

  get<T>(path: string, options?: ApiRequestOptions): Observable<T> {
    return this.http.get<T>(this.url(path), options).pipe(this.mapError());
  }

  post<T>(path: string, body?: unknown, options?: ApiRequestOptions): Observable<T> {
    return this.http.post<T>(this.url(path), body ?? null, options).pipe(this.mapError());
  }

  put<T>(path: string, body?: unknown, options?: ApiRequestOptions): Observable<T> {
    return this.http.put<T>(this.url(path), body ?? null, options).pipe(this.mapError());
  }

  patch<T>(path: string, body?: unknown, options?: ApiRequestOptions): Observable<T> {
    return this.http.patch<T>(this.url(path), body ?? null, options).pipe(this.mapError());
  }

  delete<T>(path: string, options?: ApiRequestOptions): Observable<T> {
    return this.http.delete<T>(this.url(path), options).pipe(this.mapError());
  }

  private mapError<T>() {
    return catchError<T, Observable<never>>((error: unknown) =>
      throwError(() =>
        error instanceof HttpErrorResponse
          ? toApiError(error)
          : new ApiError(0, null, error instanceof Error ? error.message : String(error)),
      ),
    );
  }
}
