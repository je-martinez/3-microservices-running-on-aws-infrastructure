import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LucideChevronRight, provideLucideIcons } from '@lucide/angular';

import { OrderCard } from './order-card';
import {
  ORDER,
  ORDER_WITH_TRACKING,
  ORDER_WITHOUT_SNAPSHOT,
  PRODUCT_IMAGE,
} from '../testing/fixtures';

describe('OrderCard', () => {
  let fixture: ComponentFixture<OrderCard>;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideLucideIcons(LucideChevronRight)],
    });
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(OrderCard);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function render(entry: Parameters<typeof fixture.componentRef.setInput>[1]): HTMLElement {
    fixture.componentRef.setInput('entry', entry);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  /**
   * CONTRACT: The card shows the FORMATTED order number, rendered verbatim. The
   * server owns the separator rule; a component that inserted its own hyphen
   * would drift from the six email templates and from the detail page, and the
   * customer would read out a number support cannot find.
   * See [[friendly-order-number]]
   */
  it('shows the formatted order number, not the raw id', () => {
    const root = render(ORDER_WITH_TRACKING);

    expect(root.textContent).toContain('260815-8KJ4M2');
    // The canonical form is never shown to a human.
    expect(root.textContent).not.toContain('2608158KJ4M2');
  });

  /**
   * CONTRACT: An order predating the backfill has `orderNumber: null` and must
   * fall back to the id rather than rendering a blank heading. This is the
   * common case for historical rows, not an edge one.
   */
  it('falls back to the order id when the order has no number', () => {
    const root = render({
      ...ORDER_WITH_TRACKING,
      order: { ...ORDER_WITH_TRACKING.order, orderNumber: null },
    });

    expect(root.textContent).toContain(ORDER.id);
  });

  it('renders the line image from the snapshot on the order', () => {
    const root = render(ORDER_WITH_TRACKING);
    const image = root.querySelector('img');

    expect(image?.getAttribute('src')).toBe(PRODUCT_IMAGE.uri);
    expect(image?.getAttribute('alt')).toBe('Field Tote 18L');
  });

  /**
   * CONTRACT: The null path is the COMMON case, not an edge one — every order
   * placed before the snapshot landed carries it. An unguarded `[src]` binds
   * an empty string, which browsers resolve against the page URL and request:
   * a broken image on every historical row.
   */
  it('renders the placeholder, and no img, for a line with no image', () => {
    const root = render({ order: ORDER_WITHOUT_SNAPSHOT, tracking: null });

    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.bg-surface-subtle')).toBeTruthy();
  });

  /** One thumbnail per line, whichever branch each line takes. */
  it('renders one thumbnail per line across both branches', () => {
    // The strip is tracked by productId, so a second line needs its own id.
    const older = { ...ORDER_WITHOUT_SNAPSHOT.lines[0], productId: 'prd_8hTnW4kQjB' };
    const order = { ...ORDER, lines: [ORDER.lines[0], older] };
    const root = render({ order, tracking: null });

    expect(root.querySelectorAll('img')).toHaveLength(1);
    expect(root.querySelectorAll('.bg-surface-subtle')).toHaveLength(1);
  });

  /** The image must not blow the card out: a 720x1080 asset is cropped square. */
  it('constrains the thumbnail to the design square', () => {
    const image = render(ORDER_WITH_TRACKING).querySelector('img');

    expect(image?.className).toContain('object-cover');
    expect(image?.className).toContain('h-[2.875rem]');
    expect(image?.className).toContain('md:h-[3.25rem]');
  });
});
