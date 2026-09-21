import { afterEach, describe, expect, it, vi } from 'vitest';
import { onCLS, onINP, onLCP } from 'web-vitals';

import { APP_CONFIG } from '../config/app-config';
import { initRum, isRumStarted, getRumLoggerProvider, getActivePageSpan, notifyPageChanged } from './rum';

vi.mock('web-vitals', () => ({
  onLCP: vi.fn(),
  onCLS: vi.fn(),
  onINP: vi.fn(),
  onTTFB: vi.fn(),
  onFCP: vi.fn(),
}));

/**
 * CONTRACT: APP_CONFIG.rumEnabled is a readonly property on a frozen-shape
 * object, not a mutable module export — tests override it with
 * Object.defineProperty rather than reassignment, and restore it afterward so
 * later spec files see the real parsed value.
 */
function setRumEnabled(value: boolean): void {
  Object.defineProperty(APP_CONFIG, 'rumEnabled', { value, configurable: true });
}

// WHY: The Angular unit-test harness rejects vi.mock on relative imports, so
// initRum()'s real `import('./rum-sdk')` runs here past vitest's 5000ms
// default. `started` is a module-level singleton for the file's lifetime, so
// flag-on assertions after the first check deltas, not absolutes.
const DYNAMIC_IMPORT_TIMEOUT = 15000;

describe('initRum', () => {
  afterEach(() => {
    setRumEnabled(false);
    vi.clearAllMocks();
  });

  // WHY: Must run before any flag-on test in this file — isRumStarted() is a
  // module-level singleton that never goes back to false once true.
  it('registers nothing when the flag is off, before the SDK has ever started', () => {
    setRumEnabled(false);

    initRum();

    expect(isRumStarted()).toBe(false);
    expect(getRumLoggerProvider()).toBeUndefined();
    expect(getActivePageSpan()).toBeUndefined();
  });

  it('drops a navigation notification silently when the SDK has not loaded', () => {
    setRumEnabled(false);

    expect(() => notifyPageChanged('/orders')).not.toThrow();
    expect(getActivePageSpan()).toBeUndefined();
  });

  it(
    'starts the SDK when the flag is on, and registers a callback for every vitals metric',
    async () => {
      setRumEnabled(true);
      expect(getRumLoggerProvider()).toBeUndefined();

      initRum();
      await vi.waitFor(() => expect(isRumStarted()).toBe(true), {
        timeout: DYNAMIC_IMPORT_TIMEOUT,
      });

      expect(getRumLoggerProvider()).toBeDefined();
      expect(onLCP).toHaveBeenCalledTimes(1);
      expect(onCLS).toHaveBeenCalledTimes(1);
      expect(onINP).toHaveBeenCalledTimes(1);
      expect(getActivePageSpan()).toBeDefined();
    },
    DYNAMIC_IMPORT_TIMEOUT,
  );

  it(
    'registers one more vitals callback per additional flag-on call, once the module is loaded',
    async () => {
      setRumEnabled(true);

      initRum();
      await vi.waitFor(() => expect(onLCP).toHaveBeenCalledTimes(1), {
        timeout: DYNAMIC_IMPORT_TIMEOUT,
      });
    },
    DYNAMIC_IMPORT_TIMEOUT,
  );

  it('registers no additional vitals callbacks when the flag is off', () => {
    setRumEnabled(false);

    initRum();

    expect(onLCP).not.toHaveBeenCalled();
  });
});
