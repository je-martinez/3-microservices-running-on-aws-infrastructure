import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowLeft } from '@lucide/angular';
import { Field } from '../../shared/ui/field';
import { ButtonPrimary } from '../../shared/ui/button-primary';
import { ButtonGhost } from '../../shared/ui/button-ghost';

/**
 * Design: `Login — Passwordless` (j0sCI, 1440) and
 *         `Mobile — Login Passwordless` (drEOJ, 390).
 * One component, two breakpoints (spec D8, DESIGN.md "Responsive rule").
 * Phase 1: layout and navigation only — the form does not submit anywhere.
 */
@Component({
  selector: 'app-login-passwordless',
  imports: [RouterLink, LucideArrowLeft, Field, ButtonPrimary, ButtonGhost],
  templateUrl: './login-passwordless.html',
})
export class LoginPasswordlessPage {}
