import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LucideMinus, LucidePlus, LucideTrash2, provideLucideIcons } from '@lucide/angular';

import { QtyStepper } from './qty-stepper';

describe('QtyStepper', () => {
  let fixture: ComponentFixture<QtyStepper>;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideLucideIcons(LucideMinus, LucidePlus, LucideTrash2)],
    });
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(QtyStepper);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function render(inputs: {
    quantity: number | string;
    canIncrement?: boolean;
    disabled?: boolean;
    itemName?: string;
  }): HTMLElement {
    fixture.componentRef.setInput('quantity', inputs.quantity);
    if (inputs.canIncrement !== undefined)
      fixture.componentRef.setInput('canIncrement', inputs.canIncrement);
    if (inputs.disabled !== undefined) fixture.componentRef.setInput('disabled', inputs.disabled);
    if (inputs.itemName !== undefined) fixture.componentRef.setInput('itemName', inputs.itemName);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function leftKey(root: HTMLElement): HTMLButtonElement {
    const key = root.querySelector<HTMLButtonElement>('[data-testid="qty-decrease"]');
    if (!key) throw new Error('no left key rendered');
    return key;
  }

  it('emits removed, not decrement, at quantity 1', () => {
    const removed = vi.fn();
    const decrement = vi.fn();
    const root = render({ quantity: 1, itemName: 'Linen Cap' });
    fixture.componentInstance.removed.subscribe(removed);
    fixture.componentInstance.decrement.subscribe(decrement);

    leftKey(root).click();

    expect(removed).toHaveBeenCalledOnce();
    expect(decrement).not.toHaveBeenCalled();
  });

  it('emits decrement, not removed, above quantity 1', () => {
    const removed = vi.fn();
    const decrement = vi.fn();
    const root = render({ quantity: 2 });
    fixture.componentInstance.removed.subscribe(removed);
    fixture.componentInstance.decrement.subscribe(decrement);

    leftKey(root).click();

    expect(decrement).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
  });

  /**
   * CONTRACT: The left key's label names the ACTION, and at quantity 1 the
   * action is removal. The cart specs locate these keys by this exact string,
   * so the wording is a test contract shared with `cart-drawer.spec.ts`.
   */
  it('labels the left key for removal at quantity 1 and for decrease above it', () => {
    expect(leftKey(render({ quantity: 1, itemName: 'Linen Cap' })).getAttribute('aria-label')).toBe(
      'Remove Linen Cap',
    );
    expect(leftKey(render({ quantity: 3, itemName: 'Linen Cap' })).getAttribute('aria-label')).toBe(
      'Decrease quantity',
    );
  });

  /**
   * CONTRACT: `quantity` is IntLike on the wire, so "1" is legal. A component
   * comparing it with `=== 1` renders a trash icon that never appears, and
   * `"3" > 1` is a string comparison. Coerce before comparing.
   * See [[money-representation]]
   */
  it('coerces a wire-string quantity before choosing the key behaviour', () => {
    const removed = vi.fn();
    const root = render({ quantity: '1', itemName: 'Linen Cap' });
    fixture.componentInstance.removed.subscribe(removed);

    expect(root.textContent).toContain('1');
    leftKey(root).click();

    expect(removed).toHaveBeenCalledOnce();
  });

  it('blocks increment when canIncrement is false', () => {
    const increment = vi.fn();
    const root = render({ quantity: 2, canIncrement: false });
    fixture.componentInstance.increment.subscribe(increment);

    const plus = root.querySelector<HTMLButtonElement>('[data-testid="qty-increase"]');
    expect(plus?.disabled).toBe(true);
    plus?.click();

    expect(increment).not.toHaveBeenCalled();
  });

  it('disables both keys when disabled', () => {
    const root = render({ quantity: 2, disabled: true });

    expect(leftKey(root).disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-testid="qty-increase"]')?.disabled).toBe(
      true,
    );
  });

  it('renders the quantity where the cart specs look for it', () => {
    const root = render({ quantity: 7 });

    expect(root.querySelector('[data-testid="cart-line-quantity"]')?.textContent?.trim()).toBe('7');
  });

  /**
   * CONTRACT: The roll animates a CLONE out and leaves the bound `<span>` in
   * place. Animating the bound node out and removing it on `finish` detaches
   * what the template owns, and Angular rewrites it to the new value anyway, so
   * both digits render stacked over each other and never resolve.
   *
   * WORKAROUND(test): jsdom implements neither `matchMedia` nor
   * `Element.animate`, so `roll()` throws on its first line and never runs
   * unless both are stubbed. Without this setup the assertions below pass
   * against the stacking bug as readily as against the fix.
   * See [[2026-09-30-cart-add-quantity-morph-design]]
   */
  it('leaves exactly one live number after a quantity change', () => {
    const finishers: (() => void)[] = [];
    vi.stubGlobal('matchMedia', () => ({ matches: false }) as MediaQueryList);
    const animate = vi.fn(() => ({
      addEventListener: (_: string, done: () => void) => finishers.push(done),
    }));
    Object.defineProperty(Element.prototype, 'animate', {
      value: animate,
      configurable: true,
      writable: true,
    });

    try {
      const root = render({ quantity: 1 });
      const counter = root.querySelector('[data-testid="cart-line-quantity"]');

      fixture.componentRef.setInput('quantity', 2);
      fixture.detectChanges();

      // The roll ran: one node leaves, one enters.
      expect(animate).toHaveBeenCalledTimes(2);

      const live = [...(counter?.children ?? [])].filter(
        (node) => node.getAttribute('aria-hidden') !== 'true',
      );
      expect(live).toHaveLength(1);
      expect(live[0]?.textContent?.trim()).toBe('2');

      finishers.forEach((done) => done());
      fixture.detectChanges();

      expect(counter?.children).toHaveLength(1);
      expect(counter?.textContent?.trim()).toBe('2');
    } finally {
      Reflect.deleteProperty(Element.prototype, 'animate');
      vi.unstubAllGlobals();
    }
  });
});
