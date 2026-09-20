import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs/operators';

import { notifyPageChanged } from './rum';

/**
 * CONTRACT: rum-sdk.ts is not an Angular service — it is a plain module
 * behind a dynamic import(), so it cannot `inject(Router)` itself. This is
 * the one piece of DI-aware wiring the page-span feature needs, kept to a
 * single subscription that forwards into rum.ts's notifyPageChanged(), which
 * is a no-op before the SDK has loaded. NavigationEnd only — NavigationStart
 * would end the outgoing page's span before its own async guards/resolvers
 * finish, misattributing their CLIENT spans to the next page.
 * See [[2026-09-19-web-rum-integration-design]]
 */
@Injectable({ providedIn: 'root' })
export class RumNavigation {
  private readonly router = inject(Router);

  start(): void {
    this.router.events.pipe(filter((event) => event instanceof NavigationEnd)).subscribe(() => {
      notifyPageChanged(location.pathname);
    });
  }
}
