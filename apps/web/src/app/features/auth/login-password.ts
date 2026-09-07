import { Component, inject, signal } from '@angular/core';
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
  imports: [RouterLink, Field, ButtonPrimary, ButtonGhost, DevFillButton],
  templateUrl: './login-password.html',
})
export class LoginPasswordPage {
  private readonly usersApi = inject(UsersApi);
  private readonly signIn = inject(SignIn);

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly showPassword = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Dev-only: fills the inputs this form owns. See dev-fill.ts. */
  protected devFill(data: DevData): void {
    this.email.set(data.email);
    this.password.set(data.password);
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.error.set(null);
    this.submitting.set(true);
    try {
      const tokens = await firstValueFrom(
        this.usersApi.login(this.email().trim(), this.password()),
      );
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
