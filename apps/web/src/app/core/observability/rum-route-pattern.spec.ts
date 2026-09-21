import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, describe, expect, it } from 'vitest';

import { routePatternOf } from './rum-route-pattern';

@Component({ template: '' })
class BlankPage {}

// WHY: Exercised through a real Router rather than a hand-built snapshot —
// the shape routePatternOf() walks (component-less '' parents, firstChild
// chains, routeConfig on each level) is produced by route matching, and a
// stubbed snapshot would assert against our own idea of it.
function configure(): Router {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: '',
          children: [
            { path: '', component: BlankPage, pathMatch: 'full' },
            { path: 'checkout', component: BlankPage },
            { path: 'orders', component: BlankPage },
            { path: 'orders/:orderId', component: BlankPage },
            { path: 'password/new', component: BlankPage },
          ],
        },
      ]),
    ],
  });
  return TestBed.inject(Router);
}

async function patternAfterNavigating(url: string): Promise<string> {
  const router = configure();
  await router.navigateByUrl(url);
  return routePatternOf(router.routerState.snapshot.root);
}

describe('routePatternOf', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('yields the parameterised pattern, never the resolved id', async () => {
    expect(await patternAfterNavigating('/orders/ord_JIfKhAqF5eD9bV7KRnReGpda')).toBe(
      '/orders/:orderId',
    );
  });

  it('yields a static route unchanged', async () => {
    expect(await patternAfterNavigating('/checkout')).toBe('/checkout');
  });

  it('keeps a multi-segment static route whole', async () => {
    expect(await patternAfterNavigating('/password/new')).toBe('/password/new');
  });

  it('reads the root path as / rather than empty', async () => {
    expect(await patternAfterNavigating('/')).toBe('/');
  });

  it('ignores a query string and fragment', async () => {
    expect(await patternAfterNavigating('/orders?page=2#top')).toBe('/orders');
  });
});
