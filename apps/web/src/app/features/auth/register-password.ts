import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideCheck } from '@lucide/angular';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { ButtonGhost } from '../../shared/ui/button-ghost';

/**
 * Design: `Register — Email & Password` (q52fsc, 1440) and
 *         `Mobile — Register Email & Password` (L4qQLy, 390).
 * One component, two breakpoints (spec D8, DESIGN.md "Responsive rule").
 * Phase 1: layout and navigation only — the form does not submit anywhere.
 */
@Component({
  selector: 'app-register-password',
  imports: [RouterLink, LucideCheck, Field, ButtonPrimary, ButtonGhost],
  templateUrl: './register-password.html',
})
export class RegisterPasswordPage {}
