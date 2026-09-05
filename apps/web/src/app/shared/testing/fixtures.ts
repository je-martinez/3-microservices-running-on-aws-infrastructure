import { HttpTestingController, TestRequest } from '@angular/common/http/testing';
import { Provider } from '@angular/core';
import { ComponentFixture } from '@angular/core/testing';
import {
  LucideArrowLeft,
  LucideChevronDown,
  LucideChevronRight,
  LucideImageOff,
  LucideLock,
  LucideMapPin,
  LucidePackage,
  LucidePackageCheck,
  LucidePhone,
  LucidePlus,
  LucideReceiptText,
  LucideRefreshCw,
  LucideTimer,
  LucideTriangleAlert,
  LucideTruck,
  LucideUser,
  LucideWarehouse,
  provideLucideIcons,
} from '@lucide/angular';

import type { Money, Order, OrderWithTracking, Product, Tracking } from '../../core/api/types';

/**
 * WHY: LucideDynamicIcon resolves an icon by NAME from the registry, so an
 * unregistered one throws at render — the screen dies before a single assertion
 * runs. This mirrors the subset app.config.ts registers for these screens.
 */
export const SCREEN_TEST_PROVIDERS: Provider[] = [
  provideLucideIcons(
    LucideArrowLeft,
    LucideChevronDown,
    LucideChevronRight,
    LucideImageOff,
    LucideLock,
    LucideMapPin,
    LucidePackage,
    LucidePackageCheck,
    LucidePhone,
    LucidePlus,
    LucideReceiptText,
    LucideRefreshCw,
    LucideTimer,
    LucideTriangleAlert,
    LucideTruck,
    LucideUser,
    LucideWarehouse,
  ),
];

/**
 * Builds a `Money` the way the server does, from cents.
 *
 * CONTRACT: `formatted` here is deliberately NOT derived by the same arithmetic
 * the component uses — a test that recomputes the display string cannot catch a
 * component that recomputes it too. Assertions compare against this literal.
 * See [[money-representation]]
 */
export function money(cents: number, formatted: string): Money {
  return { cents, amount: (cents / 100).toFixed(2), formatted, currency: 'USD' };
}

export const PRODUCT: Product = {
  id: 'prd_V1StGXR8Z5',
  name: 'Field Tote 18L',
  description: 'A weatherproof tote.',
  unitPrice: money(12800, '$128.00'),
  unitsInStock: 50,
  categories: ['BAGS'],
  image: null,
};

export const ORDER: Order = {
  id: 'ord_3kLpQx8vRn',
  userId: 'usr_qN7fD2xVwM',
  cognitoSub: 'a3c1e6d0-4f2b-4a9d-8e7c-1b6f0d2a9c44',
  subtotal: money(12800, '$128.00'),
  tax: money(1024, '$10.24'),
  shipping: money(500, '$5.00'),
  total: money(14324, '$143.24'),
  createdAt: '2026-08-15T18:22:41Z',
  // A line carries NO shipping, so these three sum to less than order.total.
  lines: [
    {
      productId: 'prd_V1StGXR8Z5',
      quantity: 1,
      subtotal: money(12800, '$128.00'),
      tax: money(1024, '$10.24'),
      total: money(13824, '$138.24'),
    },
  ],
};

export const TRACKING: Tracking = {
  id: 'trk_2pXqNzB6vT',
  user_id: 'usr_qN7fD2xVwM',
  order_id: 'ord_3kLpQx8vRn',
  status: 'PLACED',
  datetime: '2026-08-15T18:22:41Z',
  history: [
    {
      tracking_id: 'trk_2pXqNzB6vT',
      user_id: 'usr_qN7fD2xVwM',
      order_id: 'ord_3kLpQx8vRn',
      status: 'PLACED',
      datetime: '2026-08-15T18:22:41Z',
    },
  ],
};

export const ORDER_WITH_TRACKING: OrderWithTracking = { order: ORDER, tracking: TRACKING };

/**
 * Pumps until the backend holds a request whose path is `path`, ignoring its
 * query string, then returns it.
 *
 * CONTRACT: `match(string)` compares against `urlWithParams`, so a plain
 * `match('/v1/orders/my-orders')` finds NOTHING once the caller sends
 * `?includeTracking=true` — it reports "no request" for a request that was in
 * fact made correctly. Matching on `request.url` is what separates "wrong URL"
 * from "has params". See [[2026-09-04-angular-http-testing-traps]]
 */
export async function awaitPath(
  fixture: ComponentFixture<unknown>,
  controller: HttpTestingController,
  path: string,
): Promise<TestRequest> {
  for (let turn = 0; turn < 25; turn += 1) {
    const [request] = controller.match((r) => r.url === path);
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
  }
  throw new Error(`No request for ${path} within 25 turns`);
}
