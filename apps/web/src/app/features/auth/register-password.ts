import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormField, form, minLength, pattern, required } from '@angular/forms/signals';
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

const TOO_SHORT = `Your password needs at least ${MIN_PASSWORD_LENGTH} characters.`;

/**
 * Design: `Register — Email & Password` (q52fsc) and its 390 mobile frame.
 * CONTRACT: POST /users/register then POST /users/login. Register returns a
 * User, not tokens, so registration alone leaves nobody signed in.
 */
@Component({
  selector: 'app-register-password',
  imports: [RouterLink, LucideCheck, Field, FormField, ButtonPrimary, ButtonGhost, DevFillButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './register-password.html',
})
export class RegisterPasswordPage {
  private readonly usersApi = inject(UsersApi);
  private readonly signIn = inject(SignIn);

  protected readonly showPassword = signal(false);
  protected readonly accepted = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly minPasswordLength = MIN_PASSWORD_LENGTH;

  protected readonly model = signal({ fullName: '', email: '', password: '' });

  /**
   * CONTRACT: Length is the ONLY password rule here. Do NOT add Cognito's pool
   * policy (uppercase, digit, symbol) as a validator — it would stop a locally
   * valid password from reaching the server, whose wording is the only thing
   * that names the missing class. See the WARNING on submit().
   */
  protected readonly registration = form(this.model, (path) => {
    // CONTRACT: Pair every gating `required` with /\S/. Signal Forms counts a
    // value of spaces as present, so `required` alone is weaker than the
    // `.trim().length > 0` guard it replaces and would register a blank name.
    required(path.fullName, { message: 'Enter your full name.' });
    pattern(path.fullName, /\S/, { message: 'Enter your full name.' });
    required(path.email, { message: 'Enter your email.' });
    pattern(path.email, /\S/, { message: 'Enter your email.' });
    required(path.password, { message: TOO_SHORT });
    minLength(path.password, MIN_PASSWORD_LENGTH, { message: TOO_SHORT });
  });

  protected readonly canSubmit = computed(() => this.accepted() && this.registration().valid());

  /** Dev-only: fills the three inputs this form owns. See dev-fill.ts. */
  protected devFill(data: DevData): void {
    this.model.set({ fullName: data.fullName, email: data.email, password: data.password });
    this.accepted.set(true);
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    if (!this.canSubmit()) {
      // WHY: Touching the whole tree is what makes the schema's messages
      // visible — `Field` keeps an error hidden until its field is touched.
      this.registration().markAsTouched();
      this.error.set(this.blockingReason());
      return;
    }

    const { fullName, email, password } = this.model();
    this.error.set(null);
    this.submitting.set(true);
    try {
      await firstValueFrom(
        this.usersApi.register({ email: email.trim(), password, fullName: fullName.trim() }),
      );
      const tokens = await firstValueFrom(this.usersApi.login(email.trim(), password));
      await this.signIn.complete(tokens);
    } catch (error: unknown) {
      // WARNING: The client rules do NOT make the server's answer predictable —
      // Cognito's pool policy is enforced on top and rejects passwords this
      // form accepts, so its message still has to reach the user.
      this.error.set(authErrorMessage(error, { 409: EMAIL_TAKEN }));
    } finally {
      this.submitting.set(false);
    }
  }

  private blockingReason(): string {
    if (!this.accepted()) return 'Please accept the Terms and Privacy Policy to continue.';
    const password = this.registration.password();
    if (password.errors().length > 0) return password.errors()[0].message ?? TOO_SHORT;
    return 'Fill in your name, email and a password to continue.';
  }
}
