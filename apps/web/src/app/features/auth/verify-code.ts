import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowLeft, LucideShieldCheck, LucideTimer } from '@lucide/angular';
import { OtpDigit } from '../../shared/ui/otp-digit';
import { ButtonPrimary } from '../../shared/ui/button-primary';

/**
 * Design: `Verify Code — OTP` (V16TI, 1440) and `Mobile — Verify Code`
 * (zouHC, 390) as one component, two breakpoints (spec D8).
 * Six `OtpDigit`s match `^\d{6}$` in `OtpVerifyInput`. Phase 1: layout and
 * navigation only, no submission.
 */
@Component({
  selector: 'app-verify-code',
  imports: [
    RouterLink,
    LucideArrowLeft,
    LucideTimer,
    LucideShieldCheck,
    OtpDigit,
    ButtonPrimary,
  ],
  templateUrl: './verify-code.html',
})
export class VerifyCodePage {}
