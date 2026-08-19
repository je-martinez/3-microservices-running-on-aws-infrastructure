import { Component } from '@angular/core';
import { LogoLockup } from './logo-lockup';

/**
 * Design: frame `Mobile Brand Header` (u2nnov). The compact navy header used
 * atop auth screens at the 390px mobile breakpoint, replacing the desktop
 * `Brand Panel` rail — logo lockup (white wordmark) + tagline, no image or
 * feature list.
 */
@Component({
  selector: 'app-mobile-brand-header',
  imports: [LogoLockup],
  templateUrl: './mobile-brand-header.html',
})
export class MobileBrandHeader {}
