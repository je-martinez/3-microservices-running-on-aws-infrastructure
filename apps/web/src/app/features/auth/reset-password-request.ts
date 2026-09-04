import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowLeft } from '@lucide/angular';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';

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
 * The step before `/password/new`: it asks for the email the reset code is sent
 * to. Phase 1 is layout and navigation only — the form submits nowhere.
 */
@Component({
  selector: 'app-reset-password-request',
  imports: [RouterLink, LucideArrowLeft, Field, ButtonPrimary],
  templateUrl: './reset-password-request.html',
})
export class ResetPasswordRequestPage {
  protected readonly codeLength = RESET_CODE_LENGTH;
  protected readonly ttlMinutes = RESET_CODE_TTL_MINUTES;
}
