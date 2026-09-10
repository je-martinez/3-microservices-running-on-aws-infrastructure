import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiClient } from '../http/api-client';
import { StoredTokens } from '../auth/token-store';
import { Address, User } from './types';

/**
 * The auth surface of services/users/openapi.yaml, one method per operation.
 *
 * CONTRACT: Paths are gateway-relative and carry NO "/v1" prefix —
 * APP_CONFIG.apiGatewayUrl supplies it. Writing "/v1/users/login" here yields a
 * request to "/v1/v1/users/login", answered by the gateway's own 404 rather
 * than by Users. See [[2026-09-04-web-gateway-integration-design]]
 */

/** POST /users/register — `address` and `phoneNumber` are optional. */
export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  address?: Address;
  phoneNumber?: string;
}

/**
 * POST /users/register/passwordless.
 * CONTRACT: `password` is NOT part of this body — the account has none, and
 * Fastify's `additionalProperties: false` rejects the whole request if one is
 * sent, with a 400 that reads as a validation error on an unrelated field.
 */
export interface RegisterPasswordlessInput {
  email: string;
  fullName: string;
  address?: Address;
  phoneNumber?: string;
}

/**
 * PATCH /users/me — a PARTIAL profile update; omitted keys are left alone.
 *
 * CONTRACT: `address` is sent as the STRUCTURED object, never a flattened
 * string. Verified live: the service persists these six keys verbatim and
 * GET /users/me reads them back in the same shape. Sending a single-line
 * string stores an address no reader can split back into city or postal code.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
export interface UpdateProfileInput {
  fullName?: string;
  address?: Address;
  phoneNumber?: string;
}

/** POST /users/otp/start — the opaque session to hand back to otp/verify. */
export interface OtpStartResponse {
  session: string;
}

/**
 * POST /users/otp/verify.
 * CONTRACT: All THREE fields are required. A screen holding only `session` and
 * `code` cannot complete the call, and the user's only recovery is restarting
 * the challenge — so `email` must travel from the start screen too.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
export interface OtpVerifyInput {
  email: string;
  session: string;
  code: string;
}

/** POST /users/password/confirm. */
export interface ConfirmPasswordResetInput {
  email: string;
  code: string;
  newPassword: string;
}

/** POST /users/password/forgot — always 202, regardless of the email. */
export interface PasswordResetAccepted {
  status: 'accepted';
}

/** POST /users/password/confirm success body. */
export interface PasswordResetConfirmed {
  status: 'password_updated';
}

@Injectable({ providedIn: 'root' })
export class UsersApi {
  private readonly api = inject(ApiClient);

  register(input: RegisterInput): Observable<User> {
    return this.api.post<User>('/users/register', input);
  }

  registerPasswordless(input: RegisterPasswordlessInput): Observable<User> {
    return this.api.post<User>('/users/register/passwordless', input);
  }

  login(email: string, password: string): Observable<StoredTokens> {
    return this.api.post<StoredTokens>('/users/login', { email, password });
  }

  startOtp(email: string): Observable<OtpStartResponse> {
    return this.api.post<OtpStartResponse>('/users/otp/start', { email });
  }

  verifyOtp(input: OtpVerifyInput): Observable<StoredTokens> {
    return this.api.post<StoredTokens>('/users/otp/verify', input);
  }

  /**
   * CONTRACT: This answers 202 with the SAME body whether or not the email
   * belongs to an account, deliberately. Callers must render one confirmation
   * for both — a distinct "no such account" message hands an attacker the
   * account-enumeration oracle the endpoint exists to deny.
   */
  forgotPassword(email: string): Observable<PasswordResetAccepted> {
    return this.api.post<PasswordResetAccepted>('/users/password/forgot', { email });
  }

  confirmPasswordReset(input: ConfirmPasswordResetInput): Observable<PasswordResetConfirmed> {
    return this.api.post<PasswordResetConfirmed>('/users/password/confirm', input);
  }

  /** GET /users/me — the profile the session store holds after a sign-in. */
  me(): Observable<User> {
    return this.api.get<User>('/users/me');
  }

  /** PATCH /users/me — answers 200 with the whole updated profile. */
  updateMe(input: UpdateProfileInput): Observable<User> {
    return this.api.patch<User>('/users/me', input);
  }

  /**
   * POST /users/logout — revokes the Cognito session, 204 with no body.
   * CONTRACT: No payload. Cognito revokes the access token authInterceptor
   * already attaches; a body would send the same credential twice.
   */
  logout(): Observable<void> {
    return this.api.post<void>('/users/logout', {});
  }
}
