import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { BrandPanel } from '../../shared/ui/brand-panel';
import { MobileBrandHeader } from '../../shared/ui/mobile-brand-header';

/**
 * The shared chrome of the six auth screens: the navy `Brand Panel` rail at
 * 1440 and the `Mobile Brand Header` at 390, with each routed form rendered
 * beside or below it.
 *
 * CONTRACT: The panel keeps `lg:self-stretch`. `<main>` is `min-h-screen` and
 * grows with the form, so a panel that only sizes to its own content leaves a
 * strip of page background beneath it whenever the form overflows — visible at
 * a short viewport and invisible at a tall one, which is why it survived
 * review once already. See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-auth-layout',
  imports: [BrandPanel, MobileBrandHeader, RouterOutlet],
  templateUrl: './auth-layout.html',
})
export class AuthLayout {}
