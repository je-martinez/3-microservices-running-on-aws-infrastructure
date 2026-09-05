import { Injectable, computed, signal } from '@angular/core';

/** What POST /users/otp/start hands the verify screen. */
export interface OtpChallenge {
  email: string;
  session: string;
}

/**
 * Carries the OTP challenge from the start screen to the verify screen.
 *
 * CONTRACT: BOTH `email` and `session` travel, not just the session. POST
 * /users/otp/verify requires all three of email/session/code, so a verify
 * screen holding one of them can only send an incomplete body — a 400 whose
 * only recovery is restarting the challenge.
 * See [[2026-09-04-web-gateway-integration-design]]
 */
@Injectable({ providedIn: 'root' })
export class OtpChallengeStore {
  // WHY: an in-memory signal, not router state and not a query param. A query
  // param writes the opaque Cognito session into the URL bar, history and any
  // Referer the page emits; router state is unreadable outside its navigation.
  private readonly challenge = signal<OtpChallenge | null>(null);

  readonly current = this.challenge.asReadonly();
  readonly email = computed(() => this.challenge()?.email ?? null);

  start(challenge: OtpChallenge): void {
    this.challenge.set(challenge);
  }

  /** Replaces the session after a resend, keeping the email it was started for. */
  renew(session: string): void {
    const current = this.challenge();
    if (current) this.challenge.set({ ...current, session });
  }

  clear(): void {
    this.challenge.set(null);
  }
}
