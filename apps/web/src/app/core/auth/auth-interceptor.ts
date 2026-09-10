import { HttpEvent, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { Observable, from, switchMap } from 'rxjs';

import { APP_CONFIG } from '../config/app-config';
import { TokenStore } from './token-store';

/**
 * CONTRACT: Never attach a token to these — a caller hits them BECAUSE it has
 * none, and a stale one turns a clean login into a 401 on the very path meant
 * to recover from it. Match the full path EXACTLY: `startsWith('/users')` would
 * also silence `/users/me` and `/users/me/password`, both authenticated.
 */
const PUBLIC_PATHS: readonly string[] = [
  '/users/login',
  '/users/register',
  '/users/register/passwordless',
  '/users/refresh',
  '/users/otp/start',
  '/users/otp/verify',
  '/users/password/forgot',
  '/users/password/confirm',
];

/**
 * WHY: A request URL may be relative ("/v1/users/login") or absolute, and it
 * may carry a query string or trailing slash. Reducing it to a gateway-relative
 * path before comparing is what keeps the exact match above from being fooled.
 */
export function gatewayPath(url: string): string | null {
  const prefix = APP_CONFIG.apiGatewayUrl;
  const withoutQuery = url.split(/[?#]/)[0];
  const path = withoutQuery.startsWith(prefix) ? withoutQuery.slice(prefix.length) : null;
  if (path === null) return null;
  return path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') : path;
}

/**
 * CONTRACT: refreshInterceptor shares this rather than keeping its own list.
 * Two copies drift, and the copy that forgets `/users/refresh` makes a 401 from
 * the refresh call trigger another refresh — an unbounded loop of requests
 * against Users, not a visible error.
 */
export function isPublic(url: string): boolean {
  const path = gatewayPath(url);
  return path === null || PUBLIC_PATHS.includes(path);
}

/**
 * Attaches the Cognito access token to every authenticated gateway call.
 * WHY: accessToken and not idToken — both pass the gateway's JWT authorizer
 * (verified live, see e2e/support/auth.ts), and the access token is the one
 * meant for authorizing API calls.
 */
export function authInterceptor(
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> {
  if (isPublic(req.url)) return next(req);

  const tokenStore = inject(TokenStore);
  // WHY: The read decrypts from IndexedDB and is async, so the promise becomes
  // the stream — a functional interceptor cannot block. read() resolves null
  // rather than throwing, so a signed-out caller sends the request bare.
  return from(tokenStore.read()).pipe(
    switchMap((tokens) =>
      next(
        tokens
          ? req.clone({ setHeaders: { Authorization: `Bearer ${tokens.accessToken}` } })
          : req,
      ),
    ),
  );
}
