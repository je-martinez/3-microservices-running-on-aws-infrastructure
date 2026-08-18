import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
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
