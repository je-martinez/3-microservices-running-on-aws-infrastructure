import { describe, expect, it, vi } from 'vitest';

import {
  MISSING_WS_URL_WARNING,
  SECRET_STRIPE_KEY_WARNING,
  parseAppConfig,
} from './app-config';

/**
 * CONTRACT: Every case goes through `parseAppConfig` with an explicit env object
 * and an explicit warn spy. `APP_CONFIG` itself is frozen at import time against
 * this machine's `.env`, so asserting on it would test the developer's local
 * configuration rather than the parser. See [[testing]]
 */

const VALID_ENV = {
  NG_APP_STRIPE_ENABLED: 'true',
  NG_APP_STRIPE_PUBLISHABLE_KEY: 'pk_test_abc123',
  NG_APP_API_GATEWAY_URL: '/v1',
  NG_APP_GEOCODE_ENABLED: 'true',
  NG_APP_WS_URL: 'ws://localhost:4566/ws/abc123/dev',
  NG_APP_RUM_ENABLED: 'true',
};

describe('parseAppConfig', () => {
  it('parses every variable from a fully populated environment', () => {
    const warn = vi.fn();

    expect(parseAppConfig(VALID_ENV, warn)).toEqual({
      stripeEnabled: true,
      stripePublishableKey: 'pk_test_abc123',
      apiGatewayUrl: '/v1',
      geocodeEnabled: true,
      wsUrl: 'ws://localhost:4566/ws/abc123/dev',
      rumEnabled: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves wsUrl empty and warns when NG_APP_WS_URL is absent', () => {
    const warn = vi.fn();
    const withoutWsUrl = {
      NG_APP_STRIPE_ENABLED: VALID_ENV.NG_APP_STRIPE_ENABLED,
      NG_APP_API_GATEWAY_URL: VALID_ENV.NG_APP_API_GATEWAY_URL,
      NG_APP_GEOCODE_ENABLED: VALID_ENV.NG_APP_GEOCODE_ENABLED,
    };

    expect(parseAppConfig(withoutWsUrl, warn).wsUrl).toBe('');
    expect(warn).toHaveBeenCalledWith(MISSING_WS_URL_WARNING);
  });

  it('warns for an empty NG_APP_WS_URL, the state a fresh .env.example copy lands in', () => {
    const warn = vi.fn();

    expect(parseAppConfig({ ...VALID_ENV, NG_APP_WS_URL: '' }, warn).wsUrl).toBe('');
    expect(warn).toHaveBeenCalledWith(MISSING_WS_URL_WARNING);
  });

  it('names the variable and the fix in the warning, so the log alone is actionable', () => {
    expect(MISSING_WS_URL_WARNING).toContain('NG_APP_WS_URL');
    expect(MISSING_WS_URL_WARNING).toContain('apps/web/.env');
    expect(MISSING_WS_URL_WARNING).toContain('.env.local.web');
  });

  it('falls back to /v1 when NG_APP_API_GATEWAY_URL is absent', () => {
    const withoutGateway = {
      NG_APP_STRIPE_ENABLED: VALID_ENV.NG_APP_STRIPE_ENABLED,
      NG_APP_GEOCODE_ENABLED: VALID_ENV.NG_APP_GEOCODE_ENABLED,
      NG_APP_WS_URL: VALID_ENV.NG_APP_WS_URL,
    };

    expect(parseAppConfig(withoutGateway, vi.fn()).apiGatewayUrl).toBe('/v1');
  });

  it('falls back to /v1 when NG_APP_API_GATEWAY_URL is empty', () => {
    const env = { ...VALID_ENV, NG_APP_API_GATEWAY_URL: '' };

    expect(parseAppConfig(env, vi.fn()).apiGatewayUrl).toBe('/v1');
  });

  // CONTRACT: "false" is a non-empty string and therefore truthy. Any flag read
  // as a boolean instead of compared to "true" turns every documented `=false`
  // in .env.example into an enabled feature.
  it('reads "false" as false for both flags, not as a truthy string', () => {
    const env = {
      ...VALID_ENV,
      NG_APP_STRIPE_ENABLED: 'false',
      NG_APP_GEOCODE_ENABLED: 'false',
    };
    const config = parseAppConfig(env, vi.fn());

    expect(config.stripeEnabled).toBe(false);
    expect(config.geocodeEnabled).toBe(false);
  });

  it('treats absent flags as off', () => {
    const config = parseAppConfig({ NG_APP_WS_URL: 'ws://x/y' }, vi.fn());

    expect(config.stripeEnabled).toBe(false);
    expect(config.geocodeEnabled).toBe(false);
  });

  it('defaults rumEnabled to false when unset, without warning', () => {
    const warn = vi.fn();
    const withoutRum = {
      NG_APP_STRIPE_ENABLED: VALID_ENV.NG_APP_STRIPE_ENABLED,
      NG_APP_API_GATEWAY_URL: VALID_ENV.NG_APP_API_GATEWAY_URL,
      NG_APP_GEOCODE_ENABLED: VALID_ENV.NG_APP_GEOCODE_ENABLED,
      NG_APP_WS_URL: VALID_ENV.NG_APP_WS_URL,
    };

    const config = parseAppConfig(withoutRum, warn);

    expect(config.rumEnabled).toBe(false);
    // CONTRACT: Deliberate asymmetry with NG_APP_WS_URL, which warns on unset
    // because a user-facing feature silently disappears. RUM off costs the
    // user nothing, so no console.warn fires here.
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * CONTRACT: `make env-file` seeds the CUSTOM box with the key PRESENT and
   * EMPTY, so "" is the ordinary unconfigured state, not a typo. Reading it as
   * a value hands `loadStripe("")` an empty key, which rejects with an opaque
   * Stripe error instead of leaving card entry off. See [[env-files]]
   */
  it.each([
    ['absent', undefined],
    ['empty', ''],
  ])('reads a %s publishable key as null', (_label, value) => {
    const config = parseAppConfig(
      { ...VALID_ENV, NG_APP_STRIPE_PUBLISHABLE_KEY: value },
      vi.fn(),
    );

    expect(config.stripePublishableKey).toBeNull();
  });

  /** The flag and the key are independent: on with no key is a real state. */
  it('keeps stripeEnabled true with no publishable key', () => {
    const config = parseAppConfig(
      { ...VALID_ENV, NG_APP_STRIPE_PUBLISHABLE_KEY: '' },
      vi.fn(),
    );

    expect(config.stripeEnabled).toBe(true);
    expect(config.stripePublishableKey).toBeNull();
  });

  /**
   * CONTRACT: The variable name is legitimate, so no prefix filter catches this.
   * Only the value tells a publishable key from live credentials.
   */
  it.each([
    ['a secret key', 'sk_test_51abcdef'],
    ['a restricted key', 'rk_test_51abcdef'],
    ['a webhook signing secret', 'whsec_abcdef123456'],
    ['a live secret key', 'sk_live_51abcdef'],
  ])('discards %s and warns instead of shipping it in the bundle', (_label, key) => {
    const warn = vi.fn();

    const config = parseAppConfig({ ...VALID_ENV, NG_APP_STRIPE_PUBLISHABLE_KEY: key }, warn);

    expect(config.stripePublishableKey).toBeNull();
    expect(warn).toHaveBeenCalledWith(SECRET_STRIPE_KEY_WARNING);
  });

  it('keeps a publishable key, the only Stripe key the bundle may carry', () => {
    const warn = vi.fn();

    const config = parseAppConfig(
      { ...VALID_ENV, NG_APP_STRIPE_PUBLISHABLE_KEY: 'pk_live_51abcdef' },
      warn,
    );

    expect(config.stripePublishableKey).toBe('pk_live_51abcdef');
    expect(warn).not.toHaveBeenCalledWith(SECRET_STRIPE_KEY_WARNING);
  });

  it('tells the reader to rotate the exposed key, not merely to move it', () => {
    expect(SECRET_STRIPE_KEY_WARNING).toContain('ROTATE');
    expect(SECRET_STRIPE_KEY_WARNING).toContain('STRIPE_SECRET_KEY');
  });

  it('reads "false" as false for rumEnabled, not as a truthy string', () => {
    const config = parseAppConfig({ ...VALID_ENV, NG_APP_RUM_ENABLED: 'false' }, vi.fn());

    expect(config.rumEnabled).toBe(false);
  });

  /**
   * CONTRACT: `parseAppConfig` runs at module scope, before
   * `bootstrapApplication` — a throw here escapes the `.catch` in main.ts and
   * strands the user on the navy boot loader. Every input must yield a config.
   */
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not an env object'],
    ['a number', 42],
    ['an empty object', {}],
    ['wrongly typed members', { NG_APP_WS_URL: 7, NG_APP_API_GATEWAY_URL: false }],
  ])('never throws for %s, falling back to a usable config', (_label, input) => {
    const warn = vi.fn();

    expect(() => parseAppConfig(input, warn)).not.toThrow();
    expect(parseAppConfig(input, warn)).toEqual({
      stripeEnabled: false,
      stripePublishableKey: null,
      apiGatewayUrl: '/v1',
      geocodeEnabled: false,
      wsUrl: '',
      rumEnabled: false,
    });
  });

  it('defaults to console.warn when no warn function is supplied', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      parseAppConfig({});
      expect(spy).toHaveBeenCalledWith(MISSING_WS_URL_WARNING);
    } finally {
      spy.mockRestore();
    }
  });
});
