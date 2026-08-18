import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AccountMenu } from '../../features/account/account-menu';
import { NotificationsPanel } from '../../features/notifications/notifications-panel';
import { OverlayStore } from '../overlay/overlay-store';
import { Scrim } from '../overlay/scrim';

// Hosts the routed page plus the overlay layer, per DESIGN.md "Overlays are
// not routes": cart, account menu and notifications are UI state over the
// catalogue route, not destinations of their own. Wires the OverlayStore and
// the Scrim (present only for the cart frames, via `hasScrim`). CartDrawer
// mounts in HomePage instead (Task 10); AccountMenu and NotificationsPanel
// mount here (Task 11) — both are `z-50`, above the Scrim's `z-40`, and
// render even though `hasScrim` stays false for them (no Scrim rectangle in
// their frames — see DESIGN.md "Overlays are not routes").
@Component({
  selector: 'app-shell',
  imports: [AccountMenu, NotificationsPanel, RouterOutlet, Scrim],
  template: `
    <router-outlet />
    @if (overlay.hasScrim()) {
      <app-scrim (dismiss)="overlay.close()" />
    }
    @if (overlay.active() === 'account-menu') {
      <app-account-menu />
    }
    @if (overlay.active() === 'notifications') {
      <app-notifications-panel />
    }
  `,
})
export class Shell {
  protected readonly overlay = inject(OverlayStore);
}
