import { HttpTestingController, TestRequest } from '@angular/common/http/testing';
import { Provider } from '@angular/core';
import { ComponentFixture } from '@angular/core/testing';
import {
  LucideArrowLeft,
  LucideChevronDown,
  LucideChevronRight,
  LucideImageOff,
  LucideLock,
  LucideBuilding2,
  LucideMap,
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

import type {
  Cart,
  CartLine,
  Money,
  Order,
  OrderLine,
  OrderWithTracking,
  Product,
  ProductImage,
  Tracking,
  UnavailableReason,
} from '../../core/api/types';

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
    LucideBuilding2,
    LucideMap,
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

/** The wire shape of an image: `uri`, not `url`, and always absolute. */
export const PRODUCT_IMAGE: ProductImage = {
  uri: 'http://assets.test/products/field-tote-18l.jpg',
  width: 720,
  height: 1080,
  blurhash: 'LUEy0r~CR49ENFM_xuxu9aE2o~R+',
};

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
  // Both forms, as the server sends them. The prefix matches `createdAt` below
  // (2026-08-15 → 260815), because that is how Orders derives it — a fixture
  // whose date half disagreed with its own timestamp would model a row the
  // service cannot produce. See [[friendly-order-number]]
  orderNumber: { raw: '2608158KJ4M2', formatted: '260815-8KJ4M2' },
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
      name: 'Field Tote 18L',
      quantity: 1,
      subtotal: money(12800, '$128.00'),
      tax: money(1024, '$10.24'),
      total: money(13824, '$138.24'),
      image: PRODUCT_IMAGE,
    },
  ],
};

/**
 * A line as an order placed BEFORE the snapshot landed carries it: both
 * `name` and `image` null, because those orders were deliberately not
 * backfilled. This is the common shape in existing data, not an edge case.
 */
export const UNSNAPSHOTTED_LINE: OrderLine = {
  ...ORDER.lines[0],
  name: null,
  image: null,
};

/** The same order, with its single line carrying no snapshot. */
export const ORDER_WITHOUT_SNAPSHOT: Order = { ...ORDER, lines: [UNSNAPSHOTTED_LINE] };

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

/** An ordinary, buyable cart line. */
export function cartLine(overrides: Partial<CartLine> = {}): CartLine {
  return {
    productId: 'prd_V1StGXR8Z5',
    name: 'Field Tote 18L',
    quantity: 2,
    unitsInStock: 50,
    available: true,
    unitPrice: money(12800, '$128.00'),
    subtotal: money(25600, '$256.00'),
    image: null,
    unavailableReason: null,
    ...overrides,
  };
}

/**
 * An unavailable line, in whichever of the two shapes the reason implies.
 *
 * CONTRACT: The branches are NOT interchangeable. `unknown_product` nulls
 * `name`/`unitPrice`/`subtotal`/`image`; every other reason leaves them
 * POPULATED, so a low-stock line renders its price normally. A fixture that
 * nulls both ways cannot catch a component that guards on `available`, which is
 * the exact bug these two shapes exist to expose. See [[money-representation]]
 */
export function unavailableLine(reason: UnavailableReason): CartLine {
  const base = cartLine({ available: false, unavailableReason: reason });
  if (reason !== 'unknown_product') return base;
  return { ...base, name: null, unitPrice: null, subtotal: null, image: null };
}

/**
 * A cart whose totals hold the server's invariant, `total = subtotal + tax +
 * shipping`. Shipping is 1500 because the service charges it on every cart,
 * empty ones included.
 */
export function cart(items: CartLine[], overrides: Partial<Cart> = {}): Cart {
  const subtotal = items.reduce((sum, line) => sum + Number(line.subtotal?.cents ?? 0), 0);
  const tax = Math.round(subtotal * 0.08);
  return {
    id: items.length > 0 ? 'crt_9wKpL2xRnZ' : null,
    items,
    subtotal: money(subtotal, `$${(subtotal / 100).toFixed(2)}`),
    tax: money(tax, `$${(tax / 100).toFixed(2)}`),
    shipping: money(1500, '$15.00'),
    total: money(subtotal + tax + 1500, `$${((subtotal + tax + 1500) / 100).toFixed(2)}`),
    canCheckout: items.length > 0 && items.every((line) => line.available),
    ...overrides,
  };
}

/**
 * The empty cart the server actually returns: a null id and no items, but a
 * non-zero total, because shipping is charged regardless.
 */
export const EMPTY_CART: Cart = cart([]);
