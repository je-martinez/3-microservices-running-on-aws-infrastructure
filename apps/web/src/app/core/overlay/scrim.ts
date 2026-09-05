import { Component, output } from '@angular/core';

/**
 * A transparent click-catcher over the page while the cart is open.
 *
 * CONTRACT: Keep this layer even though it paints nothing. It is what closes the
 * drawer on an outside click; deleting it leaves the X button as the only way
 * out. It carries no background by design — the dimming was removed.
 * See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-scrim',
  template: `
    <div class="fixed inset-0 z-40" role="presentation" (click)="dismiss.emit()"></div>
  `,
  host: { class: 'block' },
})
export class Scrim {
  readonly dismiss = output<void>();
}
