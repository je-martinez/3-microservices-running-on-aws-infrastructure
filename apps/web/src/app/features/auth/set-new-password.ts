import { Component, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  FormField,
  form,
  maxLength,
  minLength,
  pattern,
  required,
  validateTree,
} from '@angular/forms/signals';
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

const BAD_LENGTH_CODE = `Enter the ${CODE_LENGTH}-digit code from your email.`;
const TOO_SHORT = `Your new password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
const MISMATCH = 'The two passwords do not match.';

/**
 * Design: `Set New Password — Forced` (atwtV, 1440) and `Mobile — Set New
 * Password` (G6lEnQ, 390) as one component, two breakpoints (spec D8).
 * POST /users/password/confirm with the email carried from the request screen,
 * the emailed code, and the new password.
 */
@Component({
  selector: 'app-set-new-password',
  imports: [RouterLink, LucideCheck, LucideShieldAlert, Field, FormField, ButtonPrimary],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './set-new-password.html',
})
export class SetNewPasswordPage {
  private readonly usersApi = inject(UsersApi);
  private readonly reset = inject(PasswordResetStore);
  private readonly router = inject(Router);

  protected readonly codeLength = CODE_LENGTH;
  protected readonly minPasswordLength = MIN_PASSWORD_LENGTH;

  /** Email is prefilled from the request screen; editable when the user landed here cold. */
  protected readonly model = signal({
    email: this.reset.email() ?? '',
    code: '',
    password: '',
    confirmation: '',
  });

  protected readonly resetForm = form(this.model, (path) => {
    // CONTRACT: Pair every gating `required` with /\S/. Signal Forms counts a
    // value of spaces as present, so `required` alone is weaker than the
    // `.trim().length > 0` guard it replaces and would post a blank email.
    required(path.email, { message: 'Enter the email you asked the reset code for.' });
    pattern(path.email, /\S/, { message: 'Enter the email you asked the reset code for.' });
    required(path.code, { message: BAD_LENGTH_CODE });
    // CONTRACT: `maxLength` is bound by `[formField]`, never in the template —
    // NG8022 rejects a manual `[maxLength]` on a `[formField]` node. It is what
    // caps the numeric Field's digit strip at six.
    maxLength(path.code, CODE_LENGTH, { message: BAD_LENGTH_CODE });
    pattern(path.code, CODE_PATTERN, { message: BAD_LENGTH_CODE });
    required(path.password, { message: TOO_SHORT });
    minLength(path.password, MIN_PASSWORD_LENGTH, { message: TOO_SHORT });

    /**
     * CONTRACT: Cross-field, so it binds to the ROOT path and targets
     * `confirmation` via `fieldTree`. Do NOT move it to `path.confirmation`
     * with `validate` — a field validator re-runs only on its OWN value, so
     * editing the password after confirming leaves the mismatch unreported.
     */
    validateTree(path, (ctx) => {
      const { password, confirmation } = ctx.value();
      if (confirmation.length === 0 || confirmation === password) return undefined;
      return {
        kind: 'passwordMismatch',
        message: MISMATCH,
        fieldTree: ctx.fieldTreeOf(path.confirmation),
      };
    });
  });

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
    const value = this.model().password;
    return [
      {
        label: `At least ${MIN_PASSWORD_LENGTH} characters`,
        met: value.length >= MIN_PASSWORD_LENGTH,
      },
      {
        label: 'An uppercase and a lowercase letter',
        met: /[a-z]/.test(value) && /[A-Z]/.test(value),
      },
      { label: 'At least one number', met: /\d/.test(value) },
      { label: 'At least one symbol (!?@#$)', met: /[^A-Za-z0-9]/.test(value) },
    ];
  });

  /**
   * WHY: An empty confirmation is not yet a mismatch, so the schema stays
   * silent on it — but it must not let submit through either.
   */
  protected readonly canSubmit = computed(
    () => this.resetForm().valid() && this.model().confirmation === this.model().password,
  );

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    if (!this.canSubmit()) {
      // WHY: Touching the whole tree is what makes the schema's messages
      // visible — `Field` keeps an error hidden until its field is touched.
      this.resetForm().markAsTouched();
      this.error.set(this.blockingReason());
      return;
    }

    const { email, code, password } = this.model();
    this.error.set(null);
    this.submitting.set(true);
    try {
      await firstValueFrom(
        this.usersApi.confirmPasswordReset({
          email: email.trim(),
          code,
          newPassword: password,
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
    const { email, code, password } = this.model();
    if (email.trim().length === 0) return 'Enter the email you asked the reset code for.';
    if (!CODE_PATTERN.test(code)) return BAD_LENGTH_CODE;
    if (password.length < MIN_PASSWORD_LENGTH) return TOO_SHORT;
    return MISMATCH;
  }
}
