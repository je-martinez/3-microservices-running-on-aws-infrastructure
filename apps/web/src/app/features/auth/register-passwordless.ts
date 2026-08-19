import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowLeft, LucideCheck, LucideInfo } from '@lucide/angular';
import { BrandPanel } from '../../shared/ui/brand-panel';
import { MobileBrandHeader } from '../../shared/ui/mobile-brand-header';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { ButtonGhost } from '../../shared/ui/button-ghost';

/**
 * Design: `Register — Passwordless` (UK1Bu, 1440) and
 *         `Mobile — Register Passwordless` (t2OrS, 390).
 * One component, two breakpoints (spec D8, DESIGN.md "Responsive rule").
 * Phase 1: layout and navigation only — the form does not submit anywhere.
 */
@Component({
  selector: 'app-register-passwordless',
  imports: [
    RouterLink,
    LucideArrowLeft,
    LucideCheck,
    LucideInfo,
    BrandPanel,
    MobileBrandHeader,
    Field,
    ButtonPrimary,
    ButtonGhost,
  ],
  templateUrl: './register-passwordless.html',
})
export class RegisterPasswordlessPage {}
