import { Component, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { form, required, email as emailValidator, FormField } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { LucideArrowLeft } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';

import { UsersApi } from '../../core/api/users-api';
import { DevFillButton } from '../../core/dev/dev-fill-button';
import type { DevData } from '../../core/dev/dev-fill';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { PasswordResetStore } from './password-reset';
import { authErrorMessage } from './auth-errors';

/**
 * CONTRACT: These MIRROR the Users service and are not free copy. `reset-code.ts`
 * exports RESET_CODE_TTL_SECONDS=600 and RESET_CODE_LENGTH=6, and the reset email
 * derives its own wording from them so the two cannot drift. The 202 from
 * POST /v1/users/password/forgot carries no TTL — it is deliberately identical
 * whether or not the email exists — so the value cannot be read at runtime.
 * See [[openapi-specs]]
 */
const RESET_CODE_TTL_MINUTES = 10;
const RESET_CODE_LENGTH = 6;

/**
 * Design: `Reset Password — Request` (P1pmu1, 1440) and `Mobile — Reset
 * Password` (f1j8HV, 390) as one component, two breakpoints (spec D8).
 * POST /users/password/forgot, then on to /password/new to enter the code.
 */
@Component({
  selector: 'app-reset-password-request',
  imports: [RouterLink, LucideArrowLeft, FormField, Field, ButtonPrimary, DevFillButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './reset-password-request.html',
})
export class ResetPasswordRequestPage {
  private readonly usersApi = inject(UsersApi);
  private readonly reset = inject(PasswordResetStore);
  private readonly router = inject(Router);

  protected readonly codeLength = RESET_CODE_LENGTH;
  protected readonly ttlMinutes = RESET_CODE_TTL_MINUTES;

  protected readonly model = signal({ email: '' });

  protected readonly resetForm = form(this.model, (path) => {
    required(path.email, { message: 'Enter your email' });
    emailValidator(path.email, { message: 'Enter a valid email' });
  });

  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly sent = signal(false);

  /**
   * CONTRACT: One confirmation for EVERY accepted request, never a branch on
   * whether the account exists. The endpoint answers an identical 202 either
   * way precisely so it reveals nothing; branching here re-opens the
   * account-enumeration oracle client-side, where it reads just as easily.
   * See [[2026-09-04-web-gateway-integration-design]]
   */
  /** Dev-only: fills the inputs this form owns. See dev-fill.ts. */
  protected devFill(data: DevData): void {
    this.model.set({ email: data.email });
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    // CONTRACT: Mark the fields touched before the validity gate, or an empty
    // form submitted straight from the keyboard renders no message at all —
    // `Field` hides an error until its field is touched.
    this.resetForm().markAsTouched();
    if (this.resetForm().invalid()) return;

    const email = this.model().email.trim();
    this.error.set(null);
    this.submitting.set(true);
    try {
      await firstValueFrom(this.usersApi.forgotPassword(email));
      this.reset.request(email);
      this.sent.set(true);
    } catch (error: unknown) {
      // Only a transport or validation failure lands here — an unknown email is
      // a 202 like any other, and takes the success path above.
      this.error.set(authErrorMessage(error));
    } finally {
      this.submitting.set(false);
    }
  }

  protected continueToCode(): Promise<boolean> {
    return this.router.navigateByUrl('/password/new');
  }
}
