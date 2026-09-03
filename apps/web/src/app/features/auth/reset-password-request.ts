import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowLeft } from '@lucide/angular';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';

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
export class ResetPasswordRequestPage {}
