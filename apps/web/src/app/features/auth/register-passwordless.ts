import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormField, form, pattern, required } from '@angular/forms/signals';
import { LucideArrowLeft, LucideCheck, LucideInfo } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';

import { ApiError } from '../../core/http/api-client';
import { UsersApi } from '../../core/api/users-api';
import { DevFillButton } from '../../core/dev/dev-fill-button';
import type { DevData } from '../../core/dev/dev-fill';
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
    FormField,
    ButtonPrimary,
    ButtonGhost,
    DevFillButton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './register-passwordless.html',
})
export class RegisterPasswordlessPage {
  private readonly usersApi = inject(UsersApi);
  private readonly challenge = inject(OtpChallengeStore);
  private readonly router = inject(Router);

  protected readonly accepted = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly model = signal({ fullName: '', email: '' });

  protected readonly registration = form(this.model, (path) => {
    // CONTRACT: Pair every gating `required` with /\S/. Signal Forms counts a
    // value of spaces as present, so `required` alone is weaker than the
    // `.trim().length > 0` guard it replaces and would register a blank name.
    required(path.fullName, { message: 'Enter your full name.' });
    pattern(path.fullName, /\S/, { message: 'Enter your full name.' });
    required(path.email, { message: 'Enter your email.' });
    pattern(path.email, /\S/, { message: 'Enter your email.' });
  });

  protected readonly canSubmit = computed(() => this.accepted() && this.registration().valid());

  /** Dev-only: fills the inputs this form owns. See dev-fill.ts. */
  protected devFill(data: DevData): void {
    this.model.set({ fullName: data.fullName, email: data.email });
    this.accepted.set(true);
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    if (!this.canSubmit()) {
      // WHY: Touching the whole tree is what makes the schema's messages
      // visible — `Field` keeps an error hidden until its field is touched.
      this.registration().markAsTouched();
      this.error.set(
        this.accepted()
          ? 'Fill in your name and email to continue.'
          : 'Please accept the Terms and Privacy Policy to continue.',
      );
      return;
    }

    const email = this.model().email.trim();
    this.error.set(null);
    this.submitting.set(true);
    try {
      /**
       * CONTRACT: A 409 (`email_exists`) is NOT a dead end — fall through to the
       * OTP challenge. Users refuses to REGISTER a duplicate address, but
       * `otp/start` happily issues a code for an existing account, password or
       * passwordless (verified live). Surfacing the 409 instead strands a user
       * on the one screen that cannot get them in.
       * See [[2026-09-04-web-gateway-integration-design]]
       */
      await firstValueFrom(
        this.usersApi.registerPasswordless({ email, fullName: this.model().fullName.trim() }),
      ).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 409) return null;
        throw error;
      });
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
