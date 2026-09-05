import { Component, afterNextRender } from '@angular/core';

import { Shell } from './core/layout/shell';
import { dismissBootLoader } from './core/boot/boot-loader';

@Component({
  selector: 'app-root',
  imports: [Shell],
  template: `<app-shell />`,
})
export class App {
  constructor() {
    // WHY: `afterNextRender` and not APP_INITIALIZER — the initializer resolves
    // BEFORE the first render, so dismissing there uncovers an empty
    // `<app-root>` and the white flash returns between loader and content.
    afterNextRender(() => dismissBootLoader());
  }
}
