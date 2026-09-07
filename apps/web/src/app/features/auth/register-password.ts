import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideCheck } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';

import { UsersApi } from '../../core/api/users-api';
import { DevFillButton } from '../../core/dev/dev-fill-button';
import type { DevData } from '../../core/dev/dev-fill';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { ButtonGhost } from '../../shared/ui/button-ghost';
import { SignIn } from './sign-in';
import { authErrorMessage } from './auth-errors';

/** Mirrors ConfirmPasswordResetInput/ChangePasswordInput's `minLength: 8`. */
const MIN_PASSWORD_LENGTH = 8;

const EMAIL_TAKEN = 'An account already exists for that email. Try signing in instead.';

/**
 * Design: `Register — Email & Password` (q52fsc) and its 390 mobile frame.
 * CONTRACT: POST /users/register then POST /users/login. Register returns a
 * User, not tokens, so registration alone leaves nobody signed in.
 */
@Component({
  selector: 'app-register-password',
  imports: [RouterLink, LucideCheck, Field, ButtonPrimary, ButtonGhost, DevFillButton],
  templateUrl: './register-password.html',
})
export class RegisterPasswordPage {
  private readonly usersApi = inject(UsersApi);
  private readonly signIn = inject(SignIn);

  protected readonly fullName = signal('');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly showPassword = signal(false);
  protected readonly accepted = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly minPasswordLength = MIN_PASSWORD_LENGTH;
  protected readonly canSubmit = computed(
    () =>
      this.accepted() &&
      this.fullName().trim().length > 0 &&
      this.email().trim().length > 0 &&
      this.password().length >= MIN_PASSWORD_LENGTH,
  );

  /** Dev-only: fills the three inputs this form owns. See dev-fill.ts. */
  protected devFill(data: DevData): void {
    this.fullName.set(data.fullName);
    this.email.set(data.email);
    this.password.set(data.password);
    this.accepted.set(true);
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    if (!this.canSubmit()) {
      this.error.set(this.blockingReason());
      return;
    }

    const email = this.email().trim();
    const password = this.password();
    this.error.set(null);
    this.submitting.set(true);
    try {
      await firstValueFrom(
        this.usersApi.register({ email, password, fullName: this.fullName().trim() }),
      );
      const tokens = await firstValueFrom(this.usersApi.login(email, password));
      await this.signIn.complete(tokens);
    } catch (error: unknown) {
      // WARNING: The client length check does NOT make the server's answer
      // predictable — Cognito's pool policy (uppercase, digit, symbol) is
      // enforced on top and rejects passwords this form accepts, so its message
      // still has to reach the user.
      this.error.set(authErrorMessage(error, { 409: EMAIL_TAKEN }));
    } finally {
      this.submitting.set(false);
    }
  }

  private blockingReason(): string {
    if (!this.accepted()) return 'Please accept the Terms and Privacy Policy to continue.';
    if (this.password().length < MIN_PASSWORD_LENGTH) {
      return `Your password needs at least ${this.minPasswordLength} characters.`;
    }
    return 'Fill in your name, email and a password to continue.';
  }
}
