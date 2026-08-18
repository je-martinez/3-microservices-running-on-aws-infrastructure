import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideStore } from '@ngrx/store';
import {
  provideLucideIcons,
  LucideArrowRight,
  LucideBell,
  LucideEyeOff,
  LucideMail,
  LucidePackage,
  LucidePackageCheck,
  LucideReceiptText,
  LucideSearch,
  LucideShieldCheck,
  LucideShoppingBag,
  LucideSparkles,
  LucideTruck,
  LucideUser,
  LucideWarehouse,
} from '@lucide/angular';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    // Phase 1 exercises almost none of this. It is registered up front so
    // phase 2 adds reducers rather than rewiring bootstrap.
    provideStore({}),
    // Every icon referenced by the shared UI primitives (Task 7), registered
    // by name for the LucideDynamicIcon component (`<svg [lucideIcon]="x">`)
    // each shared component uses to render a string-typed icon input. Add
    // here when a screen (Tasks 9-11) needs one not already listed.
    provideLucideIcons(
      LucideArrowRight,
      LucideBell,
      LucideEyeOff,
      LucideMail,
      LucidePackage,
      LucidePackageCheck,
      LucideReceiptText,
      LucideSearch,
      LucideShieldCheck,
      LucideShoppingBag,
      LucideSparkles,
      LucideTruck,
      LucideUser,
      LucideWarehouse,
    ),
  ],
};
