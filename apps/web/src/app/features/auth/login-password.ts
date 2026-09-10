import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { form, required, email as emailValidator, FormField } from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { UsersApi } from '../../core/api/users-api';
import { DevFillButton } from '../../core/dev/dev-fill-button';
import type { DevData } from '../../core/dev/dev-fill';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { ButtonGhost } from '../../shared/ui/button-ghost';
import { SignIn } from './sign-in';
import { WRONG_CREDENTIALS, authErrorMessage } from './auth-errors';

/**
 * Design: `Login — Email & Password` (I4wRF, 1440) and
 *         `Mobile — Login Email & Password` (MnqTi, 390).
 * One component, two breakpoints (spec D8, DESIGN.md "Responsive rule").
 * POST /users/login, then SignIn persists the tokens and lands the user.
 */
@Component({
  selector: 'app-login-password',
  imports: [RouterLink, FormField, Field, ButtonPrimary, ButtonGhost, DevFillButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login-password.html',
})
export class LoginPasswordPage {
  private readonly usersApi = inject(UsersApi);
  private readonly signIn = inject(SignIn);

  protected readonly model = signal({ email: '', password: '' });

  protected readonly loginForm = form(this.model, (path) => {
    required(path.email, { message: 'Enter your email' });
    emailValidator(path.email, { message: 'Enter a valid email' });
    required(path.password, { message: 'Enter your password' });
  });

  protected readonly showPassword = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Dev-only: fills the inputs this form owns. See dev-fill.ts. */
  protected devFill(data: DevData): void {
    this.model.set({ email: data.email, password: data.password });
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    // CONTRACT: Mark the fields touched before the validity gate, or an empty
    // form submitted straight from the keyboard renders no message at all —
    // `Field` hides an error until its field is touched.
    this.loginForm().markAsTouched();
    if (this.loginForm().invalid()) return;

    this.error.set(null);
    this.submitting.set(true);
    try {
      const { email, password } = this.model();
      const tokens = await firstValueFrom(this.usersApi.login(email.trim(), password));
      await this.signIn.complete(tokens);
    } catch (error: unknown) {
      // CONTRACT: A 401 here is wrong credentials, shown in place. Do NOT
      // redirect: the user is already on /login, so a navigation is a no-op
      // that discards the message and reads as the form doing nothing.
      this.error.set(authErrorMessage(error, { 401: WRONG_CREDENTIALS }));
    } finally {
      this.submitting.set(false);
    }
  }
}
