import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AccountMenu } from '../../features/account/account-menu';
import { NotificationsPanel } from '../../features/notifications/notifications-panel';
import { OverlayStore } from '../overlay/overlay-store';
import { Scrim } from '../overlay/scrim';

// Hosts the routed page plus the overlay layer: cart, account menu and
// notifications are UI state over the catalogue route, not destinations.
// CONTRACT: Every overlay panel stays `z-50`, above the Scrim's `z-40`, or it
// renders underneath it — silent at build time. AccountMenu and
// NotificationsPanel mount here and render with `hasScrim` false, since their
// frames carry no Scrim; CartDrawer mounts in HomePage.
// See [[angular-component-authoring]]
@Component({
  selector: 'app-shell',
  imports: [AccountMenu, NotificationsPanel, RouterOutlet, Scrim],
  templateUrl: './shell.html',
})
export class Shell {
  protected readonly overlay = inject(OverlayStore);
}
