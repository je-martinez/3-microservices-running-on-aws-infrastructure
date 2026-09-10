import { Injectable, signal } from '@angular/core';

/**
 * Carries the email from the reset request to the set-new-password screen.
 *
 * CONTRACT: POST /users/password/confirm takes email + code + newPassword, so
 * the address has to travel — the screen collecting the code never asks again.
 * In-memory for the same reason as OtpChallengeStore.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
@Injectable({ providedIn: 'root' })
export class PasswordResetStore {
  private readonly requestedFor = signal<string | null>(null);

  readonly email = this.requestedFor.asReadonly();

  request(email: string): void {
    this.requestedFor.set(email);
  }

  clear(): void {
    this.requestedFor.set(null);
  }
}
