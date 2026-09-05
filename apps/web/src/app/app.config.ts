import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withViewTransitions } from '@angular/router';
import { provideStore } from '@ngrx/store';
import {
  provideLucideIcons,
  LucideApple,
  LucideArrowLeft,
  LucideArrowRight,
  LucideBell,
  LucideBuilding2,
  LucideCheck,
  LucideChevronDown,
  LucideChevronLeft,
  LucideCreditCard,
  LucideEyeOff,
  LucideInfo,
  LucideLink,
  LucideLock,
  LucideLockKeyhole,
  LucideLogOut,
  LucideMail,
  LucideMapPin,
  LucideMinus,
  LucidePackage,
  LucidePackageCheck,
  LucidePhone,
  LucidePlus,
  LucideReceiptText,
  LucideSearch,
  LucideShieldAlert,
  LucideShieldCheck,
  LucideShoppingBag,
  LucideSparkles,
  LucideTimer,
  LucideTruck,
  LucideUser,
  LucideWandSparkles,
  LucideWarehouse,
  LucideX,
} from '@lucide/angular';

import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth-interceptor';
import { refreshInterceptor } from './core/auth/refresh-interceptor';
import { rehydrateSession } from './core/auth/session-rehydration';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // CONTRACT: Boot waits on this before the first navigation resolves. Drop
    // it and authGuard runs against an unread token store, so a reload on
    // /orders redirects to /login even with a valid session persisted.
    // See [[2026-09-04-web-gateway-integration-design]]
    provideAppInitializer(rehydrateSession),
    // Route changes cross-fade instead of hard-cutting; the shared chrome
    // (brand panel, app header) is pinned by `view-transition-name` in
    // styles.css so only the changing content animates.
    // WHY: `skipInitialTransition` — landing directly on a URL has nothing to
    // transition from, and a fade on first paint reads as slowness.
    provideRouter(routes, withViewTransitions({ skipInitialTransition: true })),
    // CONTRACT: Interceptor order is execution order. refreshInterceptor stays
    // BEFORE authInterceptor, so its retry re-enters that one and picks up the
    // new token instead of replaying the expired header already set.
    provideHttpClient(withInterceptors([refreshInterceptor, authInterceptor])),
    // Phase 1 exercises almost none of this. It is registered up front so
    // phase 2 adds reducers rather than rewiring bootstrap.
    provideStore({}),
    // Every icon referenced by the shared UI primitives (Task 7), registered
    // by name for the LucideDynamicIcon component (`<svg [lucideIcon]="x">`)
    // each shared component uses to render a string-typed icon input. Add
    // here when a screen (Tasks 9-11) needs one not already listed.
    provideLucideIcons(
      LucideApple,
      LucideArrowLeft,
      LucideArrowRight,
      LucideBell,
      LucideBuilding2,
      LucideCheck,
      LucideChevronDown,
      LucideChevronLeft,
      LucideCreditCard,
      LucideEyeOff,
      LucideInfo,
      LucideLink,
      LucideLock,
      LucideLockKeyhole,
      LucideLogOut,
      LucideMail,
      LucideMapPin,
      LucideMinus,
      LucidePackage,
      LucidePackageCheck,
      LucidePhone,
      LucidePlus,
      LucideReceiptText,
      LucideSearch,
      LucideShieldAlert,
      LucideShieldCheck,
      LucideShoppingBag,
      LucideSparkles,
      LucideTimer,
      LucideTruck,
      LucideUser,
      LucideWandSparkles,
      LucideWarehouse,
      LucideX,
    ),
  ],
};
