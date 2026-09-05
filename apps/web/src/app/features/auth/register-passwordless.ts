import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideArrowLeft, LucideCheck, LucideInfo } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';

import { UsersApi } from '../../core/api/users-api';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { ButtonGhost } from '../../shared/ui/button-ghost';
import { OtpChallengeStore } from './otp-challenge';
import { authErrorMessage } from './auth-errors';

const EMAIL_TAKEN = 'An account already exists for that email. Try signing in instead.';

/**
 * Design: `Register — Passwordless` (UK1Bu, 1440) and
 *         `Mobile — Register Passwordless` (t2OrS, 390) as one responsive
 *         component (spec D8, DESIGN.md "Responsive rule").
 * POST /users/register/passwordless, then /users/otp/start and on to /verify.
 */
@Component({
  selector: 'app-register-passwordless',
  imports: [
    RouterLink,
    LucideArrowLeft,
    LucideCheck,
    LucideInfo,
    Field,
    ButtonPrimary,
    ButtonGhost,
  ],
  templateUrl: './register-passwordless.html',
})
export class RegisterPasswordlessPage {
  private readonly usersApi = inject(UsersApi);
  private readonly challenge = inject(OtpChallengeStore);
  private readonly router = inject(Router);

  protected readonly fullName = signal('');
  protected readonly email = signal('');
  protected readonly accepted = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly canSubmit = computed(
    () => this.accepted() && this.fullName().trim().length > 0 && this.email().trim().length > 0,
  );

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    if (!this.canSubmit()) {
      this.error.set(
        this.accepted()
          ? 'Fill in your name and email to continue.'
          : 'Please accept the Terms and Privacy Policy to continue.',
      );
      return;
    }

    const email = this.email().trim();
    this.error.set(null);
    this.submitting.set(true);
    try {
      await firstValueFrom(
        this.usersApi.registerPasswordless({ email, fullName: this.fullName().trim() }),
      );
      const { session } = await firstValueFrom(this.usersApi.startOtp(email));
      this.challenge.start({ email, session });
      await this.router.navigateByUrl('/verify');
    } catch (error: unknown) {
      this.error.set(authErrorMessage(error, { 409: EMAIL_TAKEN }));
    } finally {
      this.submitting.set(false);
    }
  }
}
