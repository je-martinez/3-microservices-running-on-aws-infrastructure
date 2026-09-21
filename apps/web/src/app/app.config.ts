import { provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import {
  ApplicationConfig,
  ErrorHandler,
  inject,
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
  LucideMap,
  LucideMapPin,
  LucideMinus,
  LucidePackage,
  LucidePackageCheck,
  LucidePartyPopper,
  LucidePhone,
  LucidePlus,
  LucideReceiptText,
  LucideSearch,
  LucideShieldAlert,
  LucideShieldCheck,
  LucideShoppingBag,
  LucideSparkles,
  LucideStore,
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
import { loadRestoredProfile } from './core/auth/profile-loader';
import { rehydrateSession } from './core/auth/session-rehydration';
import { rumPropagationInterceptor } from './core/observability/rum-propagation-interceptor';
import { RumErrorHandler } from './core/observability/rum-error-handler';
import { RumNavigation } from './core/observability/rum-navigation';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // CONTRACT: provideBrowserGlobalErrorListeners() above already forwards
    // window's error and unhandledrejection events into ErrorHandler — do
    // NOT add separate window.onerror/unhandledrejection listeners in
    // rum.ts, which would double-report every global error.
    // See [[2026-09-19-web-rum-integration-design]]
    { provide: ErrorHandler, useClass: RumErrorHandler },
    // CONTRACT: Boot waits on this before the first navigation resolves. Drop
    // it and authGuard runs against an unread token store, so a reload on
    // /orders redirects to /login even with a valid session persisted.
    // See [[2026-09-04-web-gateway-integration-design]]
    provideAppInitializer(rehydrateSession),
    // CONTRACT: Runs AFTER rehydrateSession, and needs it: the profile fetch
    // goes out with the restored token, so it must not start before the token
    // store has been read. Rehydration only proves a session exists — without
    // this the header, account menu and profile render an empty user after
    // every reload, while routing works.
    // See [[2026-09-04-web-gateway-integration-design]]
    provideAppInitializer(loadRestoredProfile),
    // CONTRACT: Subscribes to Router events once, at boot, whether or not the
    // RUM flag is on — RumNavigation only forwards into rum.ts's
    // notifyPageChanged(), a no-op with the flag off. This is the sole DI
    // touchpoint for the page-span feature (see rum-navigation.ts); rum-sdk.ts
    // itself is never an injectable. See [[2026-09-19-web-rum-integration-design]]
    provideAppInitializer(() => inject(RumNavigation).start()),
    // Route changes cross-fade instead of hard-cutting; the shared chrome
    // (brand panel, app header) is pinned by `view-transition-name` in
    // styles.css so only the changing content animates.
    // WHY: `skipInitialTransition` — landing directly on a URL has nothing to
    // transition from, and a fade on first paint reads as slowness.
    provideRouter(routes, withViewTransitions({ skipInitialTransition: true })),
    // CONTRACT: Interceptor order is execution order. refreshInterceptor stays
    // BEFORE authInterceptor, so its retry re-enters that one and picks up the
    // new token instead of replaying the expired header already set.
    // rumPropagationInterceptor stays LAST: it reads the request's final URL
    // and needs nothing from the other two.
    provideHttpClient(
      withXhr(),
      withInterceptors([refreshInterceptor, authInterceptor, rumPropagationInterceptor]),
    ),
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
      LucideMap,
      LucideMapPin,
      LucideMinus,
      LucidePackage,
      LucidePackageCheck,
      LucidePartyPopper,
      LucidePhone,
      LucidePlus,
      LucideReceiptText,
      LucideSearch,
      LucideShieldAlert,
      LucideShieldCheck,
      LucideShoppingBag,
      LucideSparkles,
      LucideStore,
      LucideTimer,
      LucideTruck,
      LucideUser,
      LucideWandSparkles,
      LucideWarehouse,
      LucideX,
    ),
  ],
};
