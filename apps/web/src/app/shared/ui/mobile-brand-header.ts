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
  template: `
    <div class="bg-brand-navy-deep flex w-full flex-col gap-[14px] p-6">
      <app-logo-lockup [onDark]="true" />
      <h1 class="text-surface-white text-[19px] leading-[1.3] font-bold tracking-[-0.4px]">
        Fewer clicks between you and what you want.
      </h1>
    </div>
  `,
})
export class MobileBrandHeader {}
