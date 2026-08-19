import { Component } from '@angular/core';
import { LucideCheck, LucideShieldAlert } from '@lucide/angular';
import { BrandPanel } from '../../shared/ui/brand-panel';
import { MobileBrandHeader } from '../../shared/ui/mobile-brand-header';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';

/**
 * Design: `Set New Password — Forced` (atwtV, 1440) and
 *         `Mobile — Set New Password` (G6lEnQ, 390).
 * One component, two breakpoints (spec D8, DESIGN.md "Responsive rule").
 * Renders the password checklist the frame shows (3 rules met, 1 not) —
 * phase 1 has no live validation wiring that state up yet. Phase 1: layout
 * and navigation only, no submission.
 */
@Component({
  selector: 'app-set-new-password',
  imports: [LucideCheck, LucideShieldAlert, BrandPanel, MobileBrandHeader, Field, ButtonPrimary],
  templateUrl: './set-new-password.html',
})
export class SetNewPasswordPage {
  protected readonly rules = [
    { label: 'At least 10 characters', met: true },
    { label: 'An uppercase and a lowercase letter', met: true },
    { label: 'At least one number', met: true },
    { label: 'At least one symbol (!?@#$)', met: false },
  ];
}
