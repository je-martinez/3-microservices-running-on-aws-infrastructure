import { Component, output } from '@angular/core';

/**
 * The `Scrim` rectangle in the cart frames. Dismisses the overlay on click.
 *
 * CONTRACT: The animation binds on the HOST and fades opacity only, never
 * `transform`. Shell removes this with `@if`, so a binding on the inner div is
 * another template and never fires; and a transformed host would become the
 * containing block for that `fixed` div, growing the document mid-animation.
 * See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-scrim',
  template: `
    <div class="fixed inset-0 z-40 bg-scrim" role="presentation" (click)="dismiss.emit()"></div>
  `,
  host: {
    'class': 'block',
    'animate.enter': 'scrim-enter',
    'animate.leave': 'scrim-leave',
  },
})
export class Scrim {
  readonly dismiss = output<void>();
}
