import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { NotificationsApi } from './notifications-api';
import { NotificationsPage } from './types';

/** The server's wire shape, snake_case, as services/users/openapi.yaml declares it. */
function wireNotification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ntf_Xd5DbZFucDVRQmYQwXF0yKli',
    type: 'ORDER_STATUS',
    title: 'Order placed',
    body: "260912-RNEKNE · Received and confirmed. We'll email your receipt.",
    metadata: {
      status: 'PLACED',
      order_id: 'ord_UCC',
      order_number: '260912-RNEKNE',
      occurred_at: '2026-09-12T06:13:28.395Z',
    },
    read_at: null,
    created_at: '2026-09-12T06:13:28.400Z',
    ...overrides,
  };
}

function wirePage(items: Record<string, unknown>[]): Record<string, unknown> {
  return { items, unread_count: 2, window_total: 57, window_days: 90 };
}

describe('NotificationsApi', () => {
  let notificationsApi: NotificationsApi;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    notificationsApi = TestBed.inject(NotificationsApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  it('lists from /v1/notifications with the filter as a query parameter', () => {
    notificationsApi.list('unread').subscribe();

    const request = controller.expectOne((r) => r.url === '/v1/notifications');
    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('filter')).toBe('unread');
    expect(request.request.url).not.toContain('/v1/v1/');
    request.flush(wirePage([]));
  });

  it('maps the snake_case page to the camelCase view model', async () => {
    const received = new Promise<NotificationsPage>((resolve) =>
      notificationsApi.list().subscribe(resolve),
    );

    controller
      .expectOne((r) => r.url === '/v1/notifications')
      .flush(wirePage([wireNotification()]));

    const page = await received;
    expect(page).toMatchObject({ unreadCount: 2, windowTotal: 57, windowDays: 90 });
    expect(page.items[0]).toMatchObject({
      id: 'ntf_Xd5DbZFucDVRQmYQwXF0yKli',
      type: 'ORDER_STATUS',
      readAt: null,
      createdAt: '2026-09-12T06:13:28.400Z',
    });
    expect(page.items[0].metadata.status).toBe('PLACED');
  });

  /**
   * CONTRACT: `readAt` carries the ISO string, not a boolean. Coercing it to
   * `read: true` loses the timestamp the row's ordering and copy both read.
   */
  it('keeps a non-null read_at as its ISO string', async () => {
    const received = new Promise<NotificationsPage>((resolve) =>
      notificationsApi.list().subscribe(resolve),
    );

    controller
      .expectOne((r) => r.url === '/v1/notifications')
      .flush(wirePage([wireNotification({ read_at: '2026-09-12T07:00:00.000Z' })]));

    expect((await received).items[0].readAt).toBe('2026-09-12T07:00:00.000Z');
  });

  it('unwraps unread_count from /v1/notifications/unread-count', async () => {
    const received = new Promise<number>((resolve) =>
      notificationsApi.unreadCount().subscribe(resolve),
    );

    controller.expectOne('/v1/notifications/unread-count').flush({ unread_count: 4 });

    expect(await received).toBe(4);
  });

  it('marks read with a PATCH carrying the id list', async () => {
    const received = new Promise((resolve) => notificationsApi.markRead(['ntf_1']).subscribe(resolve));

    const request = controller.expectOne('/v1/notifications/read');
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ ids: ['ntf_1'] });
    request.flush({ updated: 1, unread_count: 3 });

    expect(await received).toEqual({ updated: 1, unreadCount: 3 });
  });

  /**
   * CONTRACT: An empty list is a valid request answered 200 with `updated: 0`,
   * so this client must not short-circuit it into a fabricated response — the
   * store is what decides whether there is anything worth sending.
   */
  it('still issues the request for an empty id list', () => {
    notificationsApi.markRead([]).subscribe();

    const request = controller.expectOne('/v1/notifications/read');
    expect(request.request.body).toEqual({ ids: [] });
    request.flush({ updated: 0, unread_count: 3 });
  });
});
