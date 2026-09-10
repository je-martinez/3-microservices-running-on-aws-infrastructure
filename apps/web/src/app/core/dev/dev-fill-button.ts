import { Component, inject, output, signal, ChangeDetectionStrategy } from '@angular/core';
import { LucideWand } from '@lucide/angular';

import { DEV_MODE, DevData, resetDevData, sessionDevData } from './dev-fill';

/**
 * A small dev-only affordance that fills the surrounding form with plausible
 * values, so a developer exercising a flow does not retype an address.
 *
 * CONTRACT: Renders NOTHING outside dev mode. `isDevMode()` is false in any
 * production build, so the template's `@if` removes the control and the
 * dynamic `chance` import is never requested. Do NOT swap this for an NG_APP_*
 * flag — those need a Dockerfile ARG and can be switched on in a deployed
 * build. See [[2026-09-07-dev-form-autofill]]
 */
@Component({
  selector: 'app-dev-fill-button',
  imports: [LucideWand],
  templateUrl: './dev-fill-button.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
})
export class DevFillButton {
  /** Evaluated once: dev mode cannot change during a session. */
  protected readonly visible = inject(DEV_MODE);

  protected readonly busy = signal(false);

  /** Emits the generated set; each form picks the fields it owns. */
  readonly filled = output<DevData>();

  /** A fresh identity per click, so two registrations do not collide. */
  protected async fill(): Promise<void> {
    this.busy.set(true);
    try {
      resetDevData();
      const data = await sessionDevData(this.visible);
      if (data) this.filled.emit(data);
    } finally {
      this.busy.set(false);
    }
  }
}
