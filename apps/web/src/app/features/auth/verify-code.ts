import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowLeft, LucideShieldCheck, LucideTimer } from '@lucide/angular';
import { BrandPanel } from '../../shared/ui/brand-panel';
import { MobileBrandHeader } from '../../shared/ui/mobile-brand-header';
import { OtpDigit } from '../../shared/ui/otp-digit';
import { ButtonPrimary } from '../../shared/ui/button-primary';

/**
 * Design: `Verify Code — OTP` (V16TI, 1440) and
 *         `Mobile — Verify Code` (zouHC, 390).
 * One component, two breakpoints (spec D8, DESIGN.md "Responsive rule").
 * The code is 6 digits (`^\d{6}$` in `OtpVerifyInput`) — composed from six
 * `OtpDigit`s. Phase 1: layout and navigation only, no submission.
 */
@Component({
  selector: 'app-verify-code',
  imports: [
    RouterLink,
    LucideArrowLeft,
    LucideTimer,
    LucideShieldCheck,
    BrandPanel,
    MobileBrandHeader,
    OtpDigit,
    ButtonPrimary,
  ],
  templateUrl: './verify-code.html',
})
export class VerifyCodePage {}
