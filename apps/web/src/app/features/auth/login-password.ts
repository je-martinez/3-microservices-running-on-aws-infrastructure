import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BrandPanel } from '../../shared/ui/brand-panel';
import { MobileBrandHeader } from '../../shared/ui/mobile-brand-header';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { ButtonGhost } from '../../shared/ui/button-ghost';

/**
 * Design: `Login — Email & Password` (I4wRF, 1440) and
 *         `Mobile — Login Email & Password` (MnqTi, 390).
 * One component, two breakpoints (spec D8, DESIGN.md "Responsive rule").
 * Phase 1: layout and navigation only — the form does not submit anywhere.
 */
@Component({
  selector: 'app-login-password',
  imports: [RouterLink, BrandPanel, MobileBrandHeader, Field, ButtonPrimary, ButtonGhost],
  templateUrl: './login-password.html',
})
export class LoginPasswordPage {}
