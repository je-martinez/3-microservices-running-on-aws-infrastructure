import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideCheck, LucideShieldAlert } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';

import { UsersApi } from '../../core/api/users-api';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { PasswordResetStore } from './password-reset';
import { authErrorMessage } from './auth-errors';

/**
 * CONTRACT: Mirrors ConfirmPasswordResetInput — `code` is `^\d{6}$` and
 * `newPassword` is `minLength: 8`. Sending anything else is rejected by
 * Fastify's schema at the edge with a validation blob, not by Users' own error
 * handling, so the user gets no usable message about which field is wrong.
 */
const CODE_PATTERN = /^\d{6}$/;
const CODE_LENGTH = 6;
const MIN_PASSWORD_LENGTH = 8;

const BAD_CODE = 'That code is not right, or it has expired. Request a new one to try again.';

/**
 * Design: `Set New Password — Forced` (atwtV, 1440) and `Mobile — Set New
 * Password` (G6lEnQ, 390) as one component, two breakpoints (spec D8).
 * POST /users/password/confirm with the email carried from the request screen,
 * the emailed code, and the new password.
 */
@Component({
  selector: 'app-set-new-password',
  imports: [RouterLink, LucideCheck, LucideShieldAlert, Field, ButtonPrimary],
  templateUrl: './set-new-password.html',
})
export class SetNewPasswordPage {
  private readonly usersApi = inject(UsersApi);
  private readonly reset = inject(PasswordResetStore);
  private readonly router = inject(Router);

  protected readonly codeLength = CODE_LENGTH;
  protected readonly minPasswordLength = MIN_PASSWORD_LENGTH;

  /** Prefilled from the request screen; editable when the user landed here cold. */
  protected readonly email = signal(this.reset.email() ?? '');
  protected readonly code = signal('');
  protected readonly password = signal('');
  protected readonly confirmation = signal('');
  protected readonly showPassword = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  /**
   * The design's checklist, made live. Only the first rule is enforced by the
   * contract; the other three mirror the Cognito pool policy, which the server
   * applies on top and which no response exposes — so they guide rather than
   * gate. See the WARNING on submit().
   */
  protected readonly rules = computed(() => {
    const value = this.password();
    return [
      { label: `At least ${MIN_PASSWORD_LENGTH} characters`, met: value.length >= MIN_PASSWORD_LENGTH },
      { label: 'An uppercase and a lowercase letter', met: /[a-z]/.test(value) && /[A-Z]/.test(value) },
      { label: 'At least one number', met: /\d/.test(value) },
      { label: 'At least one symbol (!?@#$)', met: /[^A-Za-z0-9]/.test(value) },
    ];
  });

  protected readonly matches = computed(
    () => this.confirmation().length === 0 || this.confirmation() === this.password(),
  );

  protected readonly canSubmit = computed(
    () =>
      this.email().trim().length > 0 &&
      CODE_PATTERN.test(this.code()) &&
      this.password().length >= MIN_PASSWORD_LENGTH &&
      this.confirmation() === this.password(),
  );

  protected onCodeInput(value: string): void {
    this.code.set(value.replace(/\D/g, '').slice(0, CODE_LENGTH));
    this.error.set(null);
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    if (!this.canSubmit()) {
      this.error.set(this.blockingReason());
      return;
    }

    this.error.set(null);
    this.submitting.set(true);
    try {
      await firstValueFrom(
        this.usersApi.confirmPasswordReset({
          email: this.email().trim(),
          code: this.code(),
          newPassword: this.password(),
        }),
      );
      this.reset.clear();
      await this.router.navigateByUrl('/login');
    } catch (error: unknown) {
      // WARNING: A password that satisfies every rule above can still be
      // rejected here — Cognito's pool policy is enforced server-side and this
      // client has no way to read it, so the server's own message must reach
      // the user rather than being replaced with a generic failure.
      this.error.set(authErrorMessage(error, { 401: BAD_CODE }));
    } finally {
      this.submitting.set(false);
    }
  }

  private blockingReason(): string {
    if (this.email().trim().length === 0) return 'Enter the email you asked the reset code for.';
    if (!CODE_PATTERN.test(this.code())) {
      return `Enter the ${this.codeLength}-digit code from your email.`;
    }
    if (this.password().length < MIN_PASSWORD_LENGTH) {
      return `Your new password needs at least ${this.minPasswordLength} characters.`;
    }
    return 'The two passwords do not match.';
  }
}
