import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { OverlayStore } from '../overlay/overlay-store';
import { Scrim } from '../overlay/scrim';

// Hosts the routed page plus the overlay layer, per DESIGN.md "Overlays are
// not routes": cart, account menu and notifications are UI state over the
// catalogue route, not destinations of their own. This task wires the
// OverlayStore and the Scrim (present only for the cart frames, via
// `hasScrim`); the panel components themselves (CartDrawer, AccountMenu,
// NotificationsPanel) arrive in Tasks 10-11 and mount in the seam below.
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, Scrim],
  template: `
    <router-outlet />
    @if (overlay.hasScrim()) {
      <app-scrim (dismiss)="overlay.close()" />
    }
    <!-- Task 10/11 seam: cart / account-menu / notifications panels mount
         here, switched on overlay.active(). -->
  `,
})
export class Shell {
  protected readonly overlay = inject(OverlayStore);
}
