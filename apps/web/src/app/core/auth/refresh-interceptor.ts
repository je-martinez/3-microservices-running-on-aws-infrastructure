import {
  HttpClient,
  HttpErrorResponse,
  HttpEvent,
  HttpHandlerFn,
  HttpRequest,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, finalize, from, of, shareReplay, switchMap, throwError } from 'rxjs';

import { APP_CONFIG } from '../config/app-config';
import { gatewayPath, isPublic } from './auth-interceptor';
import { SignOut } from '../../features/auth/sign-out';
import { StoredTokens, TokenStore } from './token-store';

/**
 * POST /v1/users/refresh, verified live against the running stack.
 * CONTRACT: The response carries exactly `accessToken` + `idToken` and NO
 * refreshToken — Users does not rotate it. Persisting the response as-is
 * therefore drops the refresh token and logs the user out on the next expiry;
 * the original one must be carried over.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
interface RefreshResponse {
  accessToken: string;
  idToken: string;
}

const REFRESH_PATH = '/users/refresh';
const SIGN_OUT_PATH = '/users/logout';

/**
 * Runs the single in-flight refresh, shared by every request that needs it.
 *
 * CONTRACT: One refresh per burst. Five parallel calls that all 401 must
 * produce ONE POST to /v1/users/refresh — without the shared subscription each
 * fires its own and the losers of that race are signed out mid-session.
 * `shareReplay(1)` multicasts; the `finalize` reset lets a LATER expiry refresh
 * again instead of replaying this stale result forever.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
@Injectable({ providedIn: 'root' })
export class RefreshCoordinator {
  private readonly http = inject(HttpClient);
  private readonly tokenStore = inject(TokenStore);
  private readonly signOutService = inject(SignOut);

  private inFlight: Observable<StoredTokens> | null = null;

  /** Emits the refreshed tokens, or errors once the session has been torn down. */
  refresh(): Observable<StoredTokens> {
    this.inFlight ??= this.request().pipe(
      finalize(() => (this.inFlight = null)),
      shareReplay(1),
    );
    return this.inFlight;
  }

  private request(): Observable<StoredTokens> {
    return from(this.tokenStore.read()).pipe(
      switchMap((stored) => {
        if (!stored) return throwError(() => new Error('No refresh token stored'));
        return this.http
          .post<RefreshResponse>(`${APP_CONFIG.apiGatewayUrl}${REFRESH_PATH}`, {
            refreshToken: stored.refreshToken,
          })
          .pipe(
            switchMap((response) => {
              const tokens: StoredTokens = {
                accessToken: response.accessToken,
                idToken: response.idToken,
                refreshToken: stored.refreshToken,
              };
              return from(this.tokenStore.write(tokens)).pipe(switchMap(() => of(tokens)));
            }),
          );
      }),
      catchError((error: unknown) => from(this.signOut()).pipe(switchMap(() => throwError(() => error)))),
    );
  }

  /**
   * WHY: A failed refresh is a logged-out user, not a page-level error.
   * `discard`, not `complete`: the token that just failed to refresh cannot
   * authorize a revocation, so calling the server would only delay the redirect.
   */
  private async signOut(): Promise<void> {
    await this.signOutService.discard();
  }
}

/**
 * Retries an authenticated call once, after refreshing an expired access token.
 *
 * CONTRACT: Register this BEFORE authInterceptor in withInterceptors(). Order
 * is execution order, so only from there does the retry re-enter authInterceptor
 * and pick up the NEW token; registered after, the retry replays the expired
 * Authorization header and 401s again.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
export function refreshInterceptor(
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> {
  // A public path has no token to refresh, and `/users/refresh` is in that list
  // — which is what stops a 401 from the refresh call recursing into another.
  if (isPublic(req.url)) return next(req);

  // CONTRACT: Sign-out is unrefreshable, but NOT public — it needs the very
  // token it revokes, so it cannot join PUBLIC_PATHS without losing its
  // Authorization header. Retrying it instead loops forever: a 401 here
  // refreshes, the refresh fails, the failure signs out, and signing out calls
  // this path again. See [[2026-09-04-web-gateway-integration-design]]
  if (gatewayPath(req.url) === SIGN_OUT_PATH) return next(req);

  const coordinator = inject(RefreshCoordinator);
  return next(req).pipe(
    catchError((error: unknown) => {
      // Only an expired credential is refreshable: a 403 is an authorization
      // decision and a 5xx is the server's problem, and refreshing either
      // hides the real status behind a redirect to /login.
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
        return throwError(() => error);
      }
      return coordinator.refresh().pipe(
        switchMap(() => next(req.clone())),
        catchError(() => throwError(() => error)),
      );
    }),
  );
}
