import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideArrowLeft } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';

import { UsersApi } from '../../core/api/users-api';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { ButtonGhost } from '../../shared/ui/button-ghost';
import { OtpChallengeStore } from './otp-challenge';
import { authErrorMessage } from './auth-errors';

const NO_ACCOUNT = 'We could not start a sign-in code for that email.';

/**
 * Design: `Login — Passwordless` (j0sCI, 1440) and
 *         `Mobile — Login Passwordless` (drEOJ, 390) as one responsive
 *         component (spec D8, DESIGN.md "Responsive rule").
 * POST /users/otp/start, handing email + session to /verify.
 */
@Component({
  selector: 'app-login-passwordless',
  imports: [RouterLink, LucideArrowLeft, Field, ButtonPrimary, ButtonGhost],
  templateUrl: './login-passwordless.html',
})
export class LoginPasswordlessPage {
  private readonly usersApi = inject(UsersApi);
  private readonly challenge = inject(OtpChallengeStore);
  private readonly router = inject(Router);

  protected readonly email = signal('');
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    const email = this.email().trim();
    this.error.set(null);
    this.submitting.set(true);
    try {
      const { session } = await firstValueFrom(this.usersApi.startOtp(email));
      // CONTRACT: Store the email alongside the session. POST /users/otp/verify
      // takes email + session + code, and the verify screen has no other way to
      // learn the address the code went to.
      this.challenge.start({ email, session });
      await this.router.navigateByUrl('/verify');
    } catch (error: unknown) {
      this.error.set(authErrorMessage(error, { 401: NO_ACCOUNT }));
    } finally {
      this.submitting.set(false);
    }
  }
}
