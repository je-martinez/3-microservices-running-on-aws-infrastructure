import { Component, output } from '@angular/core';

/** The `Scrim` rectangle in the cart frames. Dismisses the overlay on click. */
@Component({
  selector: 'app-scrim',
  template: `
    <div class="fixed inset-0 z-40 bg-scrim" role="presentation" (click)="dismiss.emit()"></div>
  `,
})
export class Scrim {
  readonly dismiss = output<void>();
}
