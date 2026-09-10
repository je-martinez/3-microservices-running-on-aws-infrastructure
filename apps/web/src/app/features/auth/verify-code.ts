import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { form, pattern, required } from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import { LucideArrowLeft, LucideShieldCheck, LucideTimer } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';

import { UsersApi } from '../../core/api/users-api';
import { OtpDigit } from '../../shared/ui/otp-digit';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { digitsOnly } from '../../shared/ui/numeric-input';
import { OtpChallengeStore } from './otp-challenge';
import { authErrorMessage } from './auth-errors';
import { SignIn } from './sign-in';

/**
 * CONTRACT: Mirrors `^\d{6}$` on OtpVerifyInput. Submitting a shorter or
 * non-numeric code spends a Cognito challenge attempt on a request the schema
 * rejects at the edge — the user sees a validation blob and loses one of the
 * three tries Cognito allows before the session dies.
 */
const CODE_PATTERN = /^\d{6}$/;
const CODE_LENGTH = 6;

const WRONG_CODE = 'That code is not right, or it has expired. Request a new one to try again.';
const NO_CHALLENGE = 'This code request has expired. Start again to get a new code.';

/**
 * Design: `Verify Code — OTP` (V16TI, 1440) and `Mobile — Verify Code`
 * (zouHC, 390) as one component, two breakpoints (spec D8).
 * POST /users/otp/verify with the email + session carried by OtpChallengeStore
 * and the six digits typed here.
 */
@Component({
  selector: 'app-verify-code',
  imports: [RouterLink, LucideArrowLeft, LucideTimer, LucideShieldCheck, OtpDigit, ButtonPrimary],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './verify-code.html',
})
export class VerifyCodePage {
  private readonly usersApi = inject(UsersApi);
  private readonly challenge = inject(OtpChallengeStore);
  private readonly signIn = inject(SignIn);

  protected readonly model = signal({ code: '' });

  /**
   * CONTRACT: Do NOT bind the code input with `[formField]`. `onCodeInput` is
   * what strips non-digits, and the native binding writes the raw DOM value
   * into `controlValue` alongside it — typing `12a34b` then reaches the
   * request. This schema validates what that handler already wrote.
   */
  protected readonly codeForm = form(this.model, (path) => {
    required(path.code);
    pattern(path.code, CODE_PATTERN);
  });

  protected readonly submitting = signal(false);
  protected readonly resending = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);

  protected readonly maxLength = CODE_LENGTH;
  protected readonly email = this.challenge.email;
  protected readonly code = computed(() => this.model().code);
  /** One slot per box, so the template renders the typed digits positionally. */
  protected readonly digits = computed(() =>
    Array.from({ length: CODE_LENGTH }, (_, index) => this.code()[index] ?? ''),
  );
  protected readonly canSubmit = computed(() => this.codeForm().valid());

  /** Keeps non-digits and overlong pastes out of the model entirely. */
  protected onCodeInput(element: HTMLInputElement): void {
    const value = digitsOnly(element.value, CODE_LENGTH);
    element.value = value;
    this.model.set({ code: value });
    this.error.set(null);
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    const challenge = this.challenge.current();
    if (!challenge) {
      this.error.set(NO_CHALLENGE);
      return;
    }
    // Client-side gate: no request leaves for a code that cannot possibly pass.
    if (this.codeForm().invalid()) {
      this.error.set(`Enter the ${this.maxLength}-digit code from your email.`);
      return;
    }

    this.error.set(null);
    this.notice.set(null);
    this.submitting.set(true);
    try {
      const tokens = await firstValueFrom(
        this.usersApi.verifyOtp({
          email: challenge.email,
          session: challenge.session,
          code: this.code(),
        }),
      );
      this.challenge.clear();
      await this.signIn.complete(tokens);
    } catch (error: unknown) {
      this.error.set(authErrorMessage(error, { 401: WRONG_CODE }));
    } finally {
      this.submitting.set(false);
    }
  }

  /**
   * CONTRACT: A resend replaces the session. Cognito ties the code to the
   * challenge session it minted, so keeping the old one verifies the previous
   * code and rejects the one the user just received.
   */
  protected async resend(): Promise<void> {
    const email = this.challenge.email();
    if (!email || this.resending()) {
      if (!email) this.error.set(NO_CHALLENGE);
      return;
    }
    this.error.set(null);
    this.notice.set(null);
    this.resending.set(true);
    try {
      const { session } = await firstValueFrom(this.usersApi.startOtp(email));
      this.challenge.renew(session);
      this.model.set({ code: '' });
      this.notice.set('We sent you a new code.');
    } catch (error: unknown) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.resending.set(false);
    }
  }
}
