import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { NotificationsAllPage } from './notifications-all';
import { NotificationsStore } from '../../core/notifications/notifications-store';
import { settle } from '../auth/testing';
import { NOTIFICATION_TEST_PROVIDERS } from '../../shared/testing/notification-fixtures';

const LIST = '/v1/notifications';
const READ = '/v1/notifications/read';

/**
 * CONTRACT: The clock is frozen, because TODAY/YESTERDAY/EARLIER is derived from
 * `createdAt` against "now". A spec built on the real clock passes at noon and
 * fails just after midnight, when a fixture's "today" becomes yesterday.
 */
const NOW = '2026-09-14T15:00:00.000Z';

/** The wire shape the list endpoint answers with, per notification. */
function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ntf_1',
    type: 'ORDER_STATUS',
    title: 'Out for delivery',
    body: 'Arriving today.',
    metadata: { status: 'OUT_FOR_DELIVERY', order_id: 'ord_1', occurred_at: NOW },
    read_at: null,
    created_at: NOW,
    ...overrides,
  };
}

function page(items: Record<string, unknown>[], counts: Partial<Counts> = {}) {
  return {
    items,
    unread_count: counts.unread ?? items.filter((item) => item['read_at'] === null).length,
    window_total: counts.windowTotal ?? items.length,
    window_days: 90,
  };
}

interface Counts {
  unread: number;
  windowTotal: number;
}

async function awaitRequest(
  controller: HttpTestingController,
  url: string,
  method: string,
): Promise<TestRequest> {
  for (let turn = 0; turn < 25; turn += 1) {
    const requests = controller.match((r) => r.url === url && r.method === method);
    if (requests.length === 1) return requests[0];
    if (requests.length > 1) throw new Error(`${requests.length} concurrent ${method} ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`No ${method} ${url} within 25 turns`);
}

function root(fixture: ComponentFixture<NotificationsAllPage>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function pills(fixture: ComponentFixture<NotificationsAllPage>): HTMLButtonElement[] {
  return Array.from(root(fixture).querySelectorAll<HTMLButtonElement>('[data-testid^="pill-"]'));
}

function groupLabels(fixture: ComponentFixture<NotificationsAllPage>): string[] {
  return Array.from(root(fixture).querySelectorAll('[data-testid="group-label"]')).map(
    (element) => element.textContent?.trim() ?? '',
  );
}

function timeLabels(fixture: ComponentFixture<NotificationsAllPage>): string[] {
  return Array.from(root(fixture).querySelectorAll('[data-testid="group-time"]')).map(
    (element) => element.textContent?.trim() ?? '',
  );
}

describe('NotificationsAllPage', () => {
  let fixture: ComponentFixture<NotificationsAllPage>;
  let controller: HttpTestingController;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(NOW) });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        ...NOTIFICATION_TEST_PROVIDERS,
      ],
    });
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(NotificationsAllPage);
    fixture.detectChanges();
  });

  afterEach(() => {
    controller.verify({ ignoreCancelled: true });
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  /**
   * CONTRACT: Three pills with All default — deliberately UNLIKE the panel's two
   * tabs (Unread / Read). Both are served by the same `?filter=`.
   */
  it('renders three filter pills with All selected', async () => {
    (await awaitRequest(controller, LIST, 'GET')).flush(page([]));
    await settle(fixture);

    expect(pills(fixture).map((pill) => pill.textContent?.trim())).toEqual([
      'All',
      'Unread',
      'Read',
    ]);
    expect(pills(fixture)[0].getAttribute('aria-pressed')).toBe('true');
  });

  /**
   * CONTRACT: Hammering one pill costs ONE request. Six clicks on Unread issuing
   * six GETs is an open tap on the gateway from a single button, and this is the
   * regression that spec exists for.
   */
  it('issues one request no matter how many times the same pill is clicked', async () => {
    (await awaitRequest(controller, LIST, 'GET')).flush(page([]));
    await settle(fixture);

    for (let click = 0; click < 6; click += 1) pills(fixture)[1].click();
    const first = await awaitRequest(controller, LIST, 'GET');
    first.flush(page([]));
    await settle(fixture);

    for (let click = 0; click < 6; click += 1) pills(fixture)[1].click();
    await settle(fixture);

    expect(controller.match((r) => r.url === LIST)).toHaveLength(0);
    expect(pills(fixture)[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('re-requests the list under the chosen filter when a pill is clicked', async () => {
    (await awaitRequest(controller, LIST, 'GET')).flush(page([]));
    await settle(fixture);

    pills(fixture)[1].click();
    const refetch = await awaitRequest(controller, LIST, 'GET');

    expect(refetch.request.params.get('filter')).toBe('unread');
    refetch.flush(page([]));
    await settle(fixture);
  });

  it('groups rows into TODAY, YESTERDAY and EARLIER with a format per group', async () => {
    (await awaitRequest(controller, LIST, 'GET')).flush(
      page([
        wire({ id: 'ntf_today', created_at: '2026-09-14T14:48:00.000Z', read_at: NOW }),
        wire({ id: 'ntf_earlier_today', created_at: '2026-09-14T08:15:00.000Z', read_at: NOW }),
        wire({ id: 'ntf_yesterday', created_at: '2026-09-13T16:40:00.000Z', read_at: NOW }),
        wire({ id: 'ntf_earlier', created_at: '2026-08-02T10:24:00.000Z', read_at: NOW }),
      ]),
    );
    await settle(fixture);

    expect(groupLabels(fixture)).toEqual(['TODAY', 'YESTERDAY', 'EARLIER']);
    expect(timeLabels(fixture)).toEqual([
      '12 min ago',
      '8:15 am',
      '4:40 pm',
      'Aug 2 · 10:24 am',
    ]);
  });

  /**
   * CONTRACT: Mark-on-enter, with the arrival dots kept for the visit. The frame
   * shows unread rows AND a "Mark all as read" button, which reads as a
   * contradiction; sending the PATCH here and keeping the dots resolves it.
   */
  it('marks everything read on enter and keeps the arrival dots', async () => {
    (await awaitRequest(controller, LIST, 'GET')).flush(
      page([wire({ id: 'ntf_1', read_at: null })]),
    );
    await settle(fixture);

    const patch = await awaitRequest(controller, READ, 'PATCH');
    expect(patch.request.body).toEqual({ ids: ['ntf_1'] });
    patch.flush({ updated: 1, unread_count: 0 });
    await settle(fixture);

    expect(root(fixture).querySelector('[data-testid="unread-dot"]')).not.toBeNull();
  });

  it('clears the highlight on destroy so the next visit renders them read', async () => {
    (await awaitRequest(controller, LIST, 'GET')).flush(
      page([wire({ id: 'ntf_1', read_at: null })]),
    );
    await settle(fixture);
    (await awaitRequest(controller, READ, 'PATCH')).flush({ updated: 1, unread_count: 0 });
    await settle(fixture);

    const store = TestBed.inject(NotificationsStore);
    expect(store.isHighlighted('ntf_1')).toBe(true);

    fixture.destroy();

    expect(store.isHighlighted('ntf_1')).toBe(false);
  });

  it('renders the subtitle from unreadCount and windowTotal', async () => {
    (await awaitRequest(controller, LIST, 'GET')).flush(
      page([wire({ read_at: NOW })], { unread: 3, windowTotal: 7 }),
    );
    await settle(fixture);

    expect(root(fixture).querySelector('[data-testid="page-sub"]')?.textContent?.trim()).toBe(
      '3 unread · 7 in the last 90 days',
    );
  });

  it('renders an empty state rather than a bare page', async () => {
    (await awaitRequest(controller, LIST, 'GET')).flush(page([]));
    await settle(fixture);

    expect(root(fixture).querySelector('[data-testid="empty-state"]')).not.toBeNull();
    expect(root(fixture).querySelector('app-notification-item')).toBeNull();
  });
});
