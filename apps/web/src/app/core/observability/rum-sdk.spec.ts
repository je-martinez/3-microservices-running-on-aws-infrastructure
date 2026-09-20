import { LoggerProvider } from '@opentelemetry/sdk-logs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';

import { getActivePageSpan, startPageSpan, startRumSdk } from './rum-sdk';

vi.mock('web-vitals', () => ({
  onLCP: vi.fn(),
  onCLS: vi.fn(),
  onINP: vi.fn(),
  onTTFB: vi.fn(),
  onFCP: vi.fn(),
}));

describe('startRumSdk', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers a callback for every vitals metric', () => {
    startRumSdk();

    expect(onLCP).toHaveBeenCalledTimes(1);
    expect(onCLS).toHaveBeenCalledTimes(1);
    expect(onINP).toHaveBeenCalledTimes(1);
    expect(onTTFB).toHaveBeenCalledTimes(1);
    expect(onFCP).toHaveBeenCalledTimes(1);
  });

  it('returns a LoggerProvider for RumErrorHandler to log through', () => {
    const provider = startRumSdk();

    expect(provider).toBeInstanceOf(LoggerProvider);
  });

  it('starts an initial page span covering the current path', () => {
    startRumSdk();

    const span = getActivePageSpan();
    expect(span).toBeDefined();
  });
});

describe('startPageSpan', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('ends the previous page span before starting the next one', () => {
    startRumSdk();
    const first = getActivePageSpan();
    expect(first).toBeDefined();

    startPageSpan('/orders');
    const second = getActivePageSpan();

    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it('shares one trace between the page span and its children', () => {
    startRumSdk();
    startPageSpan('/orders');

    const span = getActivePageSpan();
    expect(span?.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});
