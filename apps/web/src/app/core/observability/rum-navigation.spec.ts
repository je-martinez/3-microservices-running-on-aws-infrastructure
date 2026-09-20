import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CONFIG } from '../config/app-config';
import { getActivePageSpan, initRum, isRumStarted } from './rum';
import { RumNavigation } from './rum-navigation';

// WORKAROUND(vitest): "vi.mock" on a relative import is rejected outright by
// this harness's Angular unit-test system (see rum.spec.ts) — RumNavigation
// is exercised against the REAL rum.ts, with the SDK actually loaded via
// initRum(), rather than against a mocked notifyPageChanged(). A route
// change is observed indirectly: the active page span changes identity.
const DYNAMIC_IMPORT_TIMEOUT = 15000;

function setRumEnabled(value: boolean): void {
  Object.defineProperty(APP_CONFIG, 'rumEnabled', { value, configurable: true });
}

@Component({ template: '' })
class BlankPage {}

function configure(): { router: Router; navigation: RumNavigation } {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: '', component: BlankPage },
        { path: 'orders', component: BlankPage },
      ]),
    ],
  });
  return {
    router: TestBed.inject(Router),
    navigation: TestBed.inject(RumNavigation),
  };
}

describe('RumNavigation', () => {
  afterEach(() => {
    setRumEnabled(false);
    TestBed.resetTestingModule();
  });

  // WHY: Runs FIRST and asserts on a delta (before/after this test's own
  // navigation), not on an absolute span count — a module-level singleton
  // shared with startRumSdk()'s initial page span makes an absolute count
  // fragile across the whole spec file, exactly like rum.spec.ts's ordering
  // note for isRumStarted().
  it(
    'does not start a new page span before start() is called',
    async () => {
      setRumEnabled(true);
      initRum();
      await vi.waitFor(() => expect(isRumStarted()).toBe(true), {
        timeout: DYNAMIC_IMPORT_TIMEOUT,
      });

      const { router } = configure();
      const before = getActivePageSpan();

      await router.navigateByUrl('/orders');

      expect(getActivePageSpan()).toBe(before);
    },
    DYNAMIC_IMPORT_TIMEOUT,
  );

  it(
    'starts a new page span once a navigation completes',
    async () => {
      setRumEnabled(true);
      initRum();
      await vi.waitFor(() => expect(isRumStarted()).toBe(true), {
        timeout: DYNAMIC_IMPORT_TIMEOUT,
      });

      const { router, navigation } = configure();
      navigation.start();
      const before = getActivePageSpan();

      await router.navigateByUrl('/orders');

      const after = getActivePageSpan();
      expect(after).toBeDefined();
      expect(after).not.toBe(before);
    },
    DYNAMIC_IMPORT_TIMEOUT,
  );
});
