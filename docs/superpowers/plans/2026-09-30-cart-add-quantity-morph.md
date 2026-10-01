---
title: Cart Add-to-Cart Morph and Shared Quantity Stepper Implementation Plan
type: plan
area: shared
status: draft
created: 2026-09-30
updated: 2026-09-30
tags:
  - type/plan
  - area/shared
  - status/draft
propagates-to:
  - "[[angular-component-authoring]]"
  - "[[pencil-design-extraction]]"
related:
  - "[[2026-09-30-cart-add-quantity-morph-design]]"
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[2026-09-04-angular-http-testing-traps]]"
  - "[[angular-component-authoring]]"
  - "[[pencil-design-extraction]]"
  - "[[code-comments]]"
  - "[[testing]]"
  - "[[money-representation]]"
  - "[[browser-rum]]"
  - "[[package-manager]]"
  - "[[git-workflow]]"
  - "[[doc-propagation]]"
---

# Cart Add-to-Cart Morph and Shared Quantity Stepper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Home grid's Add button morphs in place into a quantity stepper with an "In cart" chip on the product image, and that stepper is one shared component the Cart drawer uses too.

**Architecture:** A new presentational `QtyStepper` in `shared/ui` owns the control (keys, counter, trash-at-1); `ProductCard` owns the morph around it and reads its quantity from `CartStore` through a new parameterized selector; `CartLine` drops its inline stepper and mounts the shared one. All motion is CSS driven by an `.in-cart` class, except the rolling counter, which needs `element.animate()` because it requires two live nodes.

**Tech Stack:** Angular 22 (standalone, signals, `OnPush`), NgRx Signals 22, Tailwind v4 (`@theme` tokens), `@lucide/angular`, Vitest + `@angular/core/testing`, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-30-cart-add-quantity-morph-design.md` → [[2026-09-30-cart-add-quantity-morph-design]]

**Branch:** `feature/cart-add-quantity-morph`, off `main`. It already exists and already carries the spec, this plan, the three design exports and the motion prototype. Task PRs target this feature branch, never `main`. See [[git-workflow]].

**Starting state:** the design work is done and will be committed in the branch's first commit, together with the spec, the plan, the exports and the prototype (at the time of writing, `assets/web-app/web-app.pen` shows as modified against `HEAD` because the design frames were added in this session) — the `.pen` holds the three exploration frames and the new `Qty Stepper` component (`a7S8KL`), the HTML exports are in `apps/web/design/exports/`, and the motion prototype is in `assets/web-app/prototypes/`. No application code has been written yet: `qty-stepper.ts` does not exist, `product-card.ts` still has its `add` output, and `cart-line.html` still holds its inline stepper.

## Global Constraints

- **pnpm only** — never `npm` or `yarn`. Run `nvm use` before any Node command (`.nvmrc` pins 24.18.0). See [[package-manager]].
- **No new dependencies.** `@angular/animations` is explicitly rejected by the spec (Decision 9).
- **No Tailwind arbitrary values for design colours.** `grep -rnE '(bg|text|border)-\[#' apps/web/src/` must return no matches. Every colour comes from a `@theme` token in `apps/web/src/styles.css`.
- **No `px` in component Tailwind classes** — use `rem`, dividing by 16. Exception: borders and hairlines stay `px` (`border-[1px]` is correct as-is). See [[angular-component-authoring]].
- **Templates live in sibling `.html` files** via `templateUrl`, never inline `template:` backticks. See [[angular-component-authoring]].
- **Signals API only**: `input()` / `input.required()` / `output()`. Never `@Input()` / `@Output()` decorators.
- **Comments follow [[code-comments]]**: the five tags (`CONTRACT:`, `WORKAROUND(<scope>):`, `WHY:`, `WARNING:`, `TODO(JE-<id>):`), untagged ≤6 lines, >12 lines is an error, present tense only, vault refs as `See [[note-id]]` with no `docs/` prefix and no `.md`.
- **Test commands** (run from the repo root): `pnpm web:test`, `pnpm web:lint`, `pnpm web:typecheck`, `pnpm web:build`. `pnpm build` is part of "done" — the initial-bundle budget is a real gate the others do not check.
- **Never run git writes without the user's explicit confirmation** via the A/B/C/D/E menu. The commit steps below stage and compose a message; the user authorizes the write. See [[git-workflow]].
- **`aria-label` strings are a test contract**: `"Increase quantity"`, `"Decrease quantity"`, and `Remove <itemName>` at qty 1. `cart-drawer.spec.ts` locates keys by these exact strings.

## Review Focus

Input classes the spec implies but no task's tests exercise by default. Each has its test pinned to the owning task below.

1. **A product whose quantity changes from another surface while its card is mounted** — the buyer adds from the Home card, opens the cart drawer, increments there, closes it: the card's stepper must show the drawer's number, not its own stale one. (Task 2 test.)
2. **`quantity` arriving as a wire string** — `CartLine.quantity` is `IntLike`, so `"3"` is legal. A stepper comparing `quantity() === 1` against `"1"` renders a trash icon that never appears, and `quantity() > 1` on a string is a string comparison. (Task 1 test.)
3. **A failed PUT reverting an optimistic add** — the store drops the pending overlay, the card's quantity falls back to 0, and the control must morph back to Add rather than stranding an empty stepper. (Task 3 test.)
4. **Stock running out while the product sits in the cart** — `canIncrement` goes false but the stepper must stay mounted, or the buyer loses the only way to remove the item. (Task 3 test.)
5. **A product absent from the cart entirely** — `quantityOf` must answer 0, not `undefined`; `undefined > 0` is false but `undefined` reaching the counter renders the literal text. (Task 2 test.)

---

## File Structure

**Created:**
- `apps/web/src/app/shared/ui/qty-stepper.ts` — the control's class: four inputs, three outputs, the rolling-counter effect.
- `apps/web/src/app/shared/ui/qty-stepper.html` — its template: two keys, the counter, the stacked trash/minus glyphs.
- `apps/web/src/app/shared/ui/qty-stepper.spec.ts` — unit tests for the control in isolation.
- `apps/web/src/app/shared/ui/product-card.spec.ts` — new; the card has no spec today.

**Modified:**
- `apps/web/src/app/app.config.ts` — registers `LucideTrash2`.
- `apps/web/src/app/shared/testing/fixtures.ts` — adds `LucideCheck`, `LucideMinus`, `LucideTrash2` to `SCREEN_TEST_ICONS`.
- `apps/web/src/app/core/cart/cart-store.ts` — adds `quantityByProduct` and `quantityOf` to `withComputed`.
- `apps/web/src/app/core/cart/cart-store.spec.ts` — tests for the new selector.
- `apps/web/src/app/shared/ui/cart-line.html` — replaces the inline stepper block with `<app-qty-stepper>`.
- `apps/web/src/app/shared/ui/cart-line.ts` — adds `QtyStepper` to `imports`, drops the now-unused `LucideMinus`/`LucidePlus`.
- `apps/web/src/app/shared/ui/cart-line.spec.ts` — adapts to the new markup.
- `apps/web/src/app/shared/ui/product-card.ts` — injects `CartStore`, removes the `add` output, adds `quantity`/`inCart`.
- `apps/web/src/app/shared/ui/product-card.html` — the morph wrapper, the chip, the stepper.
- `apps/web/src/app/features/catalogue/home.html` — drops `(add)="addToCart(product.id)"`.
- `apps/web/src/app/features/catalogue/home.ts` — drops `addToCart()` and its `CartStore` injection.
- `apps/web/src/app/features/catalogue/home.spec.ts` — adapts.
- `apps/web/src/styles.css` — the morph/chip keyframes and the `.in-cart` rules; retargets `--spacing-control-sm`'s comment.
- `apps/web/DESIGN.md` — the three new frames and the `Qty Stepper` → path mapping.
- `assets/web-app/web-app.pen` — adds the trash icon to `a7S8KL`.

**Boundaries:** `QtyStepper` knows nothing about carts, stock or products — it receives numbers and booleans and emits intents. `ProductCard` knows about the cart and the morph. `CartLine` keeps owning its own stock rule. The store owns the index.

---

### Task 1: `QtyStepper` — the shared control

**Files:**
- Create: `apps/web/src/app/shared/ui/qty-stepper.ts`
- Create: `apps/web/src/app/shared/ui/qty-stepper.html`
- Test: `apps/web/src/app/shared/ui/qty-stepper.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the `QtyStepper` standalone component, selector `app-qty-stepper`, with inputs `quantity: number` (required), `canIncrement: boolean` (default `true`), `disabled: boolean` (default `false`), `itemName: string` (default `''`); and outputs `increment: void`, `decrement: void`, `removed: void`. Tasks 3 and 4 mount it.

- [x] **Step 1: Write the failing tests**

Create `apps/web/src/app/shared/ui/qty-stepper.spec.ts`:

```ts
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

    expect(root().textContent).toContain('1');
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
    expect(root().querySelector<HTMLButtonElement>('[data-testid="qty-increase"]')?.disabled).toBe(
      true,
    );
  });

  it('renders the quantity where the cart specs look for it', () => {
    const root = render({ quantity: 7 });

    expect(root().querySelector('[data-testid="cart-line-quantity"]')?.textContent?.trim()).toBe('7');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `nvm use && pnpm web:test -- --include 'src/app/shared/ui/qty-stepper.spec.ts'`
Expected: FAIL — `Cannot find module './qty-stepper'`.

- [x] **Step 3: Write the component class**

Create `apps/web/src/app/shared/ui/qty-stepper.ts`:

```ts
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import { LucideMinus, LucidePlus, LucideTrash2 } from '@lucide/angular';

import { toInt } from '../../core/api/types';

/** How long the counter takes to roll to a new number. */
const ROLL_MS = 200;
const ROLL_EASING = 'cubic-bezier(.2,.8,.2,1)';

/**
 * Design: `.pen` component `Qty Stepper` (`a7S8KL`), instanced by both
 * `Product Card` (`QmNIg`) and `Cart Line` (`L5XVFs`).
 *
 * CONTRACT: This control holds no cart knowledge. `canIncrement` is RECEIVED,
 * never derived — `cart-line` computes it from the line's `unitsInStock` and
 * `product-card` from the product's, two sources with different semantics that
 * this component must not choose between.
 *
 * CONTRACT: At quantity 1 the left key emits `removed`, not `decrement`. The
 * server has no per-line DELETE, so a stepper that stops at 1 leaves the buyer
 * no way to take an item out of the cart.
 * See [[2026-09-30-cart-add-quantity-morph-design]]
 */
@Component({
  selector: 'app-qty-stepper',
  imports: [LucideMinus, LucidePlus, LucideTrash2],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './qty-stepper.html',
  host: { class: 'block w-fit' },
})
export class QtyStepper {
  readonly quantity = input.required<number>();
  readonly canIncrement = input(true);
  readonly disabled = input(false);
  /** Names the item in the left key's label when that key removes it. */
  readonly itemName = input('');

  readonly increment = output<void>();
  readonly decrement = output<void>();
  readonly removed = output<void>();

  private readonly counter = viewChild.required<ElementRef<HTMLElement>>('counter');

  /**
   * CONTRACT: Coerce before comparing. `quantity` reaches here as `IntLike`, so
   * `"1" === 1` is false and `"3" > 1` compares strings — both make the trash
   * icon and the decrement branch pick the wrong side.
   */
  protected readonly count = computed(() => toInt(this.quantity()));
  protected readonly isLast = computed(() => this.count() <= 1);
  protected readonly decreaseLabel = computed(() =>
    this.isLast() ? `Remove ${this.itemName()}`.trim() : 'Decrease quantity',
  );

  constructor() {
    let previous: number | null = null;
    effect(() => {
      const next = this.count();
      const from = previous;
      previous = next;
      if (from === null || from === next) return;
      this.roll(next > from ? 1 : -1);
    });
  }

  protected onDecrease(): void {
    if (this.isLast()) this.removed.emit();
    else this.decrement.emit();
  }

  /**
   * WHY: `element.animate()` rather than a CSS transition. The roll needs the
   * outgoing and incoming numbers on screen at once, which in CSS alone means
   * keeping two nodes in the template permanently.
   */
  private roll(direction: 1 | -1): void {
    const host = this.counter().nativeElement;
    const current = host.firstElementChild as HTMLElement | null;
    if (!current || !('animate' in host)) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const incoming = current.cloneNode(true) as HTMLElement;
    incoming.textContent = String(this.count());
    host.append(incoming);

    const options = { duration: ROLL_MS, easing: ROLL_EASING } as const;
    current
      .animate(
        [
          { transform: 'translateY(0)', opacity: 1 },
          { transform: `translateY(${-direction * 100}%)`, opacity: 0 },
        ],
        { ...options, fill: 'forwards' },
      )
      .addEventListener('finish', () => current.remove());
    incoming.animate(
      [
        { transform: `translateY(${direction * 100}%)`, opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 },
      ],
      options,
    );
  }
}
```

- [x] **Step 4: Write the template**

Create `apps/web/src/app/shared/ui/qty-stepper.html`:

```html
<div
  class="border-line-strong bg-surface-white flex h-10 w-fit shrink-0 flex-row items-center justify-start rounded-lg border"
>
  <button
    type="button"
    data-testid="qty-decrease"
    class="relative flex h-full w-control-sm shrink-0 flex-row items-center justify-center disabled:opacity-40"
    [disabled]="disabled()"
    [attr.aria-label]="decreaseLabel()"
    (click)="onDecrease()"
  >
    <!-- WHY: Both glyphs stay mounted and cross-fade. Swapping the element
         instead restarts the icon at full opacity, so the morph reads as a
         flicker rather than a transition. -->
    <svg
      lucideTrash2
      class="text-ink-secondary absolute h-4 w-4 transition-[opacity,transform] duration-150"
      [class.opacity-0]="!isLast()"
      [class.scale-50]="!isLast()"
    ></svg>
    <svg
      lucideMinus
      class="text-ink-secondary absolute h-4 w-4 transition-[opacity,transform] duration-150"
      [class.opacity-0]="isLast()"
      [class.-rotate-90]="isLast()"
    ></svg>
  </button>
  <div
    #counter
    data-testid="cart-line-quantity"
    aria-live="polite"
    class="text-ink-primary relative h-full w-stepper shrink-0 overflow-hidden text-sm font-semibold"
  >
    <span class="absolute inset-0 flex items-center justify-center">{{ count() }}</span>
  </div>
  <button
    type="button"
    data-testid="qty-increase"
    class="flex h-full w-control-sm shrink-0 flex-row items-center justify-center disabled:opacity-40"
    [disabled]="disabled() || !canIncrement()"
    aria-label="Increase quantity"
    (click)="increment.emit()"
  >
    <svg lucidePlus class="text-ink-primary h-4 w-4"></svg>
  </button>
</div>
```

- [x] **Step 5: Register the trash icon in the two registries**

`LucideDynamicIcon` resolves icons by NAME from the registry, so an unregistered one throws at render and the screen dies before a single assertion runs.

In `apps/web/src/app/app.config.ts`, add `LucideTrash2` to both the import list (near `LucideMinus`, line ~31) and the `provideLucideIcons(...)` call (near line ~129). `LucideCheck` and `LucideMinus` are already registered there.

In `apps/web/src/app/shared/testing/fixtures.ts`, add `LucideCheck`, `LucideMinus` and `LucideTrash2` to `SCREEN_TEST_ICONS` — none of the three is in it today, and Task 4's `product-card.spec.ts` renders all three through `SCREEN_TEST_PROVIDERS`. Add them to that file's `@lucide/angular` import too.

Verify:
```bash
grep -nE "LucideCheck|LucideMinus|LucideTrash2" apps/web/src/app/shared/testing/fixtures.ts apps/web/src/app/app.config.ts
```
Expected: `LucideTrash2` in both files; all three in `fixtures.ts`.

- [x] **Step 6: Run tests to verify they pass**

Run: `nvm use && pnpm web:test -- --include 'src/app/shared/ui/qty-stepper.spec.ts'`
Expected: PASS, 7 tests.

- [x] **Step 7: Verify the golden rules**

Run from the repo root:
```bash
grep -rnE '(bg|text|border)-\[#' apps/web/src/app/shared/ui/qty-stepper.html
```
Expected: no matches.

Run: `nvm use && pnpm web:lint && pnpm web:typecheck`
Expected: both clean.

- [x] **Step 8: Stage, and present the commit for confirmation**

```bash
git add apps/web/src/app/shared/ui/qty-stepper.ts \
        apps/web/src/app/shared/ui/qty-stepper.html \
        apps/web/src/app/shared/ui/qty-stepper.spec.ts \
        apps/web/src/app/app.config.ts \
        apps/web/src/app/shared/testing/fixtures.ts
```

Proposed message — do NOT commit without the user's A/B/C/D/E confirmation:
```
feat(web): add the shared quantity stepper

Spec: docs/superpowers/specs/2026-09-30-cart-add-quantity-morph-design.md
Plan: docs/superpowers/plans/2026-09-30-cart-add-quantity-morph.md
```

---

### Task 2: The store's parameterized quantity selector

**Files:**
- Modify: `apps/web/src/app/core/cart/cart-store.ts` (the `withComputed` block, around lines 91-140)
- Test: `apps/web/src/app/core/cart/cart-store.spec.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: on `CartStore`, `quantityByProduct: Signal<ReadonlyMap<string, number>>` and `quantityOf: Signal<(productId: string) => number>`. Task 3 reads `store.quantityOf()(id)`.

- [x] **Step 1: Write the failing tests**

Append to `apps/web/src/app/core/cart/cart-store.spec.ts` as a new `describe` inside the existing top-level `describe('CartStore', ...)`. The file already provides `setup()`, `tick()` and `awaitCartRequest(controller, method)` — use them; do not add new helpers.

```ts
  describe('quantityOf', () => {
    /**
     * CONTRACT: Answers 0 for a product the cart does not hold, never
     * undefined. `undefined > 0` is false, so a missing fallback survives an
     * `inCart` check and then renders the literal text "undefined" in the
     * counter.
     */
    it('answers 0 for a product absent from the cart', async () => {
      const { store, controller } = setup();
      const loaded = store.load();

      (await awaitCartRequest(controller, 'GET')).flush(
        cart([cartLine({ productId: 'prd_held', quantity: 2 })]),
      );
      await loaded;

      expect(store.quantityOf()('prd_absent')).toBe(0);
      controller.verify();
    });

    /**
     * CONTRACT: `quantity` is IntLike on the wire, so "3" is legal. An index
     * built without `toInt` hands the stepper a string, and `"3" > 1` is a
     * string comparison. See [[money-representation]]
     */
    it('answers the held quantity, coerced from its wire form', async () => {
      const { store, controller } = setup();
      const loaded = store.load();

      (await awaitCartRequest(controller, 'GET')).flush(
        cart([cartLine({ productId: 'prd_held', quantity: '3' })]),
      );
      await loaded;

      expect(store.quantityOf()('prd_held')).toBe(3);
      controller.verify();
    });

    /**
     * CONTRACT: Built from `lines`, never from `cart().items`. The optimistic
     * overlay is what makes a card's stepper track the buyer's finger; an index
     * built from the raw cart shows the pre-click quantity for a whole debounce
     * window. See [[2026-09-04-web-gateway-integration-design]]
     */
    it('reflects an optimistic quantity before its PUT settles', async () => {
      const { store, controller } = setup();
      const loaded = store.load();

      (await awaitCartRequest(controller, 'GET')).flush(
        cart([cartLine({ productId: 'prd_held', quantity: 1, unitsInStock: 10 })]),
      );
      await loaded;

      store.adjustQuantity('prd_held', 4);

      expect(store.quantityOf()('prd_held')).toBe(4);
    });

    /** The index is one Map per change, not one per lookup. */
    it('reuses the same index across lookups', async () => {
      const { store, controller } = setup();
      const loaded = store.load();

      (await awaitCartRequest(controller, 'GET')).flush(
        cart([cartLine({ productId: 'prd_held', quantity: 2 })]),
      );
      await loaded;

      const first = store.quantityByProduct();
      store.quantityOf()('prd_held');

      expect(store.quantityByProduct()).toBe(first);
      controller.verify();
    });
  });
```

Note the third test deliberately omits `controller.verify()`: `adjustQuantity` arms a 350ms debounce, so a PUT is still pending when the test ends and `verify()` would fail on it. The other three settle fully.

- [x] **Step 2: Run tests to verify they fail**

Run: `nvm use && pnpm web:test -- --include 'src/app/core/cart/cart-store.spec.ts'`
Expected: FAIL — `store.quantityOf is not a function`.

- [x] **Step 3: Add the index and the selector**

In `apps/web/src/app/core/cart/cart-store.ts`, inside the existing `withComputed(({ cart, pendingQuantities }) => { ... })`, after the `lines` computed and before the returned object:

```ts
    /**
     * CONTRACT: Built from `lines`, never from `cart().items` — the optimistic
     * overlay is what makes a card's stepper track the buyer's finger.
     *
     * WHY: An index, not a `find` per consumer. The catalogue grid asks for one
     * quantity per card, so a linear scan each makes the grid O(n·m) on every
     * cart change.
     */
    const quantityByProduct = computed<ReadonlyMap<string, number>>(
      () => new Map(lines().map((line) => [line.productId, toInt(line.quantity)])),
    );
```

and add to the returned object, beside `lines`:

```ts
      quantityByProduct,
      /**
       * Quantity held of one product, 0 when the cart does not hold it.
       *
       * CONTRACT: Returns 0 for an absent product, never undefined — a card
       * reading `undefined` renders it as text in the counter.
       */
      quantityOf: computed(() => {
        const index = quantityByProduct();
        return (productId: string): number => index.get(productId) ?? 0;
      }),
```

- [x] **Step 4: Run tests to verify they pass**

Run: `nvm use && pnpm web:test -- --include 'src/app/core/cart/cart-store.spec.ts'`
Expected: PASS, including the four new tests.

- [x] **Step 5: Stage, and present the commit for confirmation**

```bash
git add apps/web/src/app/core/cart/cart-store.ts apps/web/src/app/core/cart/cart-store.spec.ts
```

Proposed message — do NOT commit without confirmation:
```
feat(web): index cart quantities by product for O(1) lookup

Spec: docs/superpowers/specs/2026-09-30-cart-add-quantity-morph-design.md
Plan: docs/superpowers/plans/2026-09-30-cart-add-quantity-morph.md
```

---

### Task 3: The morph styles

**Files:**
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: nothing.
- Produces: the class contract Task 4's template uses — a wrapper carrying `.qty-morph`, toggled with `.in-cart`, containing `.qty-morph__add`, `.qty-morph__stepper`, `.qty-morph__trace`, and a sibling `.in-cart-chip`.

- [x] **Step 1: Add the morph and chip rules**

Append to `apps/web/src/styles.css`, after the existing `@theme` blocks. These are component styles rather than tokens, so they live outside `@theme`.

```css
/* Add-to-cart morph — design variant 19 (`v10` button + `c19` chip) from
   `assets/web-app/prototypes/add-to-cart-morph.html`.
   CONTRACT: The timings below are the approved motion spec, not defaults to
   tune in passing. See [[2026-09-30-cart-add-quantity-morph-design]] */
.qty-morph {
  position: relative;
  height: 2.5rem;
  width: 5.25rem;
  /* WHY: 0.5rem literal, not a token. `rounded-lg` here is Tailwind's own
     scale step, which the components already use; the `.pen` contributes only
     `--radius-md` (10px) and there is no `--radius-lg`. */
  border-radius: 0.5rem;
  background: var(--color-brand-navy);
  overflow: hidden;
  isolation: isolate;
  transition:
    width 300ms cubic-bezier(0.2, 0.8, 0.2, 1),
    background-color 200ms ease;
}
.qty-morph.in-cart {
  width: 6.25rem;
  background: var(--color-surface-white);
}

.qty-morph__add {
  position: absolute;
  inset: 0;
  z-index: 2;
  transition: opacity 100ms ease 300ms;
}
.qty-morph.in-cart .qty-morph__add {
  opacity: 0;
  pointer-events: none;
  transition-delay: 0s;
}

.qty-morph__stepper {
  position: absolute;
  inset: 0;
  z-index: 1;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}
.qty-morph.in-cart .qty-morph__stepper {
  opacity: 1;
  pointer-events: auto;
  transition: opacity 120ms ease 200ms;
}

/* The border draws itself, then settles into the resting outline. */
.qty-morph__trace {
  position: absolute;
  inset: 0;
  z-index: 4;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.qty-morph__trace rect {
  x: 0.75px;
  y: 0.75px;
  width: calc(100% - 1.5px);
  height: calc(100% - 1.5px);
  rx: 0.4375rem;
  fill: none;
  stroke: var(--color-brand-navy);
  stroke-width: 1.5;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  transition: stroke-dashoffset 460ms cubic-bezier(0.65, 0, 0.35, 1);
}
.qty-morph.in-cart .qty-morph__trace rect {
  stroke-dashoffset: 0;
  stroke: var(--color-line-strong);
  stroke-width: 1;
  transition:
    stroke-dashoffset 460ms cubic-bezier(0.65, 0, 0.35, 1),
    stroke 300ms ease 460ms,
    stroke-width 300ms ease 460ms;
}

/* The "In cart" chip: a calm fade-down, then one green sheen. */
.in-cart-chip {
  opacity: 0;
  transform: translateY(-3px);
  pointer-events: none;
  transition:
    opacity 320ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 420ms cubic-bezier(0.22, 1, 0.36, 1);
}
.in-cart-chip.is-shown {
  opacity: 1;
  transform: none;
  transition-delay: 160ms;
}
.in-cart-chip::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  /* WHY: Derived from the token, not the prototype's raw #10B98140. A literal
     hex would drift the moment the brand's success green moves. */
  background:
    linear-gradient(
        105deg,
        transparent 35%,
        color-mix(in srgb, var(--color-success-green) 25%, transparent) 50%,
        transparent 65%
      )
      130% 0 / 250% 100% no-repeat;
}
.in-cart-chip.is-shown::after {
  animation: in-cart-sheen 900ms cubic-bezier(0.4, 0, 0.2, 1) 420ms both;
}
@keyframes in-cart-sheen {
  from {
    background-position: 130% 0;
  }
  to {
    background-position: -30% 0;
  }
}

/* CONTRACT: Motion collapses to opacity only. Keep the trace and the sheen out
   of it — a border that draws itself is motion whatever its duration. */
@media (prefers-reduced-motion: reduce) {
  .qty-morph,
  .qty-morph__add,
  .qty-morph__stepper,
  .in-cart-chip {
    transition-property: opacity;
    transition-duration: 120ms;
    transition-delay: 0s;
  }
  .qty-morph__trace rect {
    transition: none;
    stroke-dashoffset: 0;
  }
  .in-cart-chip.is-shown::after {
    animation: none;
  }
}
```

- [x] **Step 2: Retarget the stale token comment**

In `apps/web/src/styles.css`, `--spacing-control-sm` is commented as the quantity stepper's HEIGHT. The stepper is now 40px tall and this token is its key WIDTH, so the comment would misdescribe it. Change:

```css
  --spacing-control-sm: 2.125rem; /* 34px — quantity stepper height */
```

to:

```css
  --spacing-control-sm: 2.125rem; /* 34px — stepper key width, saved-card action */
```

Verify the other consumer still reads correctly:
```bash
grep -rn "control-sm" apps/web/src/app/shared/ui/saved-card-row.html
```
Expected: one hit, using it for a square action button — unaffected by the rename of intent.

- [x] **Step 3: Verify the build compiles the new CSS**

Run: `nvm use && pnpm web:build`
Expected: success, and the initial-bundle budget not exceeded.

- [x] **Step 4: Stage, and present the commit for confirmation**

```bash
git add apps/web/src/styles.css
```

Proposed message — do NOT commit without confirmation:
```
feat(web): add the add-to-cart morph and in-cart chip styles

Spec: docs/superpowers/specs/2026-09-30-cart-add-quantity-morph-design.md
Plan: docs/superpowers/plans/2026-09-30-cart-add-quantity-morph.md
```

---

### Task 4: `ProductCard` — the morph and the chip

**Files:**
- Modify: `apps/web/src/app/shared/ui/product-card.ts`
- Modify: `apps/web/src/app/shared/ui/product-card.html`
- Modify: `apps/web/src/app/features/catalogue/home.html:86`
- Modify: `apps/web/src/app/features/catalogue/home.ts`
- Test: `apps/web/src/app/shared/ui/product-card.spec.ts` (create)
- Test: `apps/web/src/app/features/catalogue/home.spec.ts`

**Interfaces:**
- Consumes: `QtyStepper` from Task 1; `CartStore.quantityOf` from Task 2; the `.qty-morph` / `.in-cart-chip` classes from Task 3.
- Produces: `ProductCard` with input `product: Product` and NO outputs.

- [x] **Step 1: Write the failing tests**

Create `apps/web/src/app/shared/ui/product-card.spec.ts`. It drives the REAL `CartStore`, which is how every cart spec in this app works — see [[2026-09-04-angular-http-testing-traps]] for the fake-timers trap `flushDebounce` avoids.

```ts
import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ProductCard } from './product-card';
import { CartStore } from '../../core/cart/cart-store';
import { awaitRequest, settle } from '../../features/auth/testing';
import { PRODUCT, SCREEN_TEST_PROVIDERS, cart, cartLine } from '../testing/fixtures';

/** Comfortably past CartStore's 350ms quantity debounce. */
const DEBOUNCE_ADVANCE_MS = 500;

/** GET and PUT both land on this path, so one constant serves every expectation. */
const CART_URL = '/v1/cart';

/**
 * CONTRACT: Restore real timers before pumping. `settle()` awaits a `setTimeout`
 * of its own, and under fake timers nothing advances it — the helper hangs until
 * the test times out, reporting a stall rather than the missing PUT the
 * assertion is about. See [[2026-09-04-angular-http-testing-traps]]
 */
async function flushDebounce(fixture: ComponentFixture<unknown>): Promise<void> {
  vi.advanceTimersByTime(DEBOUNCE_ADVANCE_MS);
  vi.useRealTimers();
  await settle(fixture);
}

describe('ProductCard', () => {
  let fixture: ComponentFixture<ProductCard>;
  let controller: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ...SCREEN_TEST_PROVIDERS],
    });
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ProductCard);
  });

  afterEach(() => {
    TestBed.inject(CartStore).forgetAfterCheckout();
    TestBed.resetTestingModule();
  });

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function render(product = PRODUCT): HTMLElement {
    fixture.componentRef.setInput('product', product);
    fixture.detectChanges();
    return root();
  }

  /** Seeds the store so the card sees a cart holding `quantity` of PRODUCT. */
  async function seedCart(quantity: number): Promise<void> {
    const store = TestBed.inject(CartStore);
    const loading = store.load();
    const request = await awaitRequest(fixture, controller, CART_URL);
    request.flush(
      cart([cartLine({ productId: PRODUCT.id, quantity, unitsInStock: PRODUCT.unitsInStock })]),
    );
    await loading;
    fixture.detectChanges();
  }

  it('shows the Add button and no chip when the cart does not hold it', () => {
    render();

    expect(root().querySelector('[data-testid="product-card-add"]')).toBeTruthy();
    expect(root().querySelector('.in-cart-chip.is-shown')).toBeNull();
    expect(root().querySelector('.qty-morph.in-cart')).toBeNull();
  });

  it('shows the stepper and the chip once the cart holds it', async () => {
    render();
    await seedCart(1);

    expect(root().querySelector('.qty-morph.in-cart')).toBeTruthy();
    expect(root().querySelector('.in-cart-chip.is-shown')).toBeTruthy();
    expect(root().querySelector('[data-testid="cart-line-quantity"]')?.textContent?.trim()).toBe(
      '1',
    );
  });

  /**
   * CONTRACT: The card reads the STORE, not a local counter. A buyer who
   * increments in the drawer and comes back must see the drawer's number.
   */
  it('follows a quantity changed from another surface', async () => {
    render();
    await seedCart(1);

    TestBed.inject(CartStore).adjustQuantity(PRODUCT.id, 5);
    fixture.detectChanges();

    expect(root().querySelector('[data-testid="cart-line-quantity"]')?.textContent?.trim()).toBe(
      '5',
    );
  });

  /**
   * CONTRACT: Out of stock while held still renders the stepper. Hiding it
   * leaves the buyer no way to remove the item they can no longer buy more of.
   */
  it('keeps the stepper for a held product that ran out of stock', async () => {
    render({ ...PRODUCT, unitsInStock: 0 });
    const store = TestBed.inject(CartStore);
    const loading = store.load();
    const request = await awaitRequest(fixture, controller, CART_URL);
    request.flush(cart([cartLine({ productId: PRODUCT.id, quantity: 2, unitsInStock: 0 })]));
    await loading;
    fixture.detectChanges();

    expect(root().querySelector('.qty-morph.in-cart')).toBeTruthy();
    expect(root().querySelector<HTMLButtonElement>('[data-testid="qty-increase"]')?.disabled).toBe(
      true,
    );
    expect(root().querySelector('[data-testid="qty-decrease"]')).toBeTruthy();
  });

  it('shows Out of stock instead of the control when not held', () => {
    render({ ...PRODUCT, unitsInStock: 0 });

    expect(root().textContent).toContain('Out of stock');
    expect(root().querySelector('.qty-morph')).toBeNull();
  });

  /**
   * CONTRACT: A failed PUT must morph the control BACK. The store drops its
   * optimistic overlay on failure, so a card holding its own `inCart` flag
   * would strand an empty stepper over a product the cart does not hold.
   */
  it('morphs back to Add when the add fails', async () => {
    render();
    vi.useFakeTimers();
    TestBed.inject(CartStore).add(PRODUCT.id);
    await flushDebounce(fixture);
    const write = await awaitRequest(fixture, controller, CART_URL);
    expect(write.request.method).toBe('PUT');
    write.flush({ message: 'nope' }, { status: 500, statusText: 'Server Error' });
    await settle(fixture);

    expect(root().querySelector('.qty-morph.in-cart')).toBeNull();
    expect(root().querySelector('[data-testid="product-card-add"]')).toBeTruthy();
  });

});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `nvm use && pnpm web:test -- --include 'src/app/shared/ui/product-card.spec.ts'`
Expected: FAIL — no `.qty-morph` in the template and no `data-testid="product-card-add"`.

- [x] **Step 3: Update the component class**

In `apps/web/src/app/shared/ui/product-card.ts`: add the `CartStore` injection and the derived signals, remove the `add` output, and add `QtyStepper` plus `LucideCheck`/`LucideTrash2` to `imports`.

```ts
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { LucideCheck, LucideImageOff, LucidePlus } from '@lucide/angular';

import { QtyStepper } from './qty-stepper';
import { type Product, toInt } from '../../core/api/types';
import { CartStore } from '../../core/cart/cart-store';
```

Replace the class body's output and add the new members:

```ts
export class ProductCard {
  readonly product = input.required<Product>();

  private readonly cart = inject(CartStore);

  /**
   * CONTRACT: Read through the store's index, never a local counter. The
   * quantity can change from the cart drawer while this card stays mounted, and
   * the store's optimistic overlay is what makes the stepper track the buyer's
   * finger during a debounce window.
   * See [[2026-09-04-web-gateway-integration-design]]
   */
  protected readonly quantity = computed(() => this.cart.quantityOf()(this.product().id));
  protected readonly inCart = computed(() => this.quantity() > 0);

  protected readonly price = computed(() => this.product().unitPrice.formatted);
  protected readonly stock = computed(() => toInt(this.product().unitsInStock));
  protected readonly outOfStock = computed(() => this.stock() === 0);
  protected readonly category = computed(() => this.product().categories[0]?.toUpperCase());
  protected readonly canIncrement = computed(() => this.quantity() < this.stock());

  /**
   * CONTRACT: Always through CartStore, never CartApi. Two fast clicks on a
   * buyer with no cart yet are the creation race that makes the losing PUT
   * answer 500 (JE-246); the store's queue is what serializes them.
   */
  protected onAdd(): void {
    void this.cart.add(this.product().id);
  }

  /**
   * CONTRACT: `adjustQuantity`, never `setQuantity`. Writing per click makes
   * five taps five sequential PUTs, each a round trip the buyer waits out with
   * a stale total on screen.
   */
  protected onIncrement(): void {
    this.cart.adjustQuantity(this.product().id, this.quantity() + 1);
  }

  protected onDecrement(): void {
    this.cart.adjustQuantity(this.product().id, this.quantity() - 1);
  }

  protected onRemove(): void {
    void this.cart.remove(this.product().id);
  }
}
```

Update the decorator's `imports` to `[LucideCheck, LucideImageOff, LucidePlus, QtyStepper]` — Angular `imports` are PER-TEMPLATE, and `LucideMinus`/`LucideTrash2` are drawn by `qty-stepper.html`, which declares them itself; listing them here emits `NG8113: not used within the template`. Also extend the class doc comment to record that the card now reads the store (keep it under 12 lines, present tense).

- [x] **Step 4: Update the template**

In `apps/web/src/app/shared/ui/product-card.html`, add the chip inside the image block. Both image branches need it, so wrap the existing `@if (product().image; as image) { ... } @else { ... }` in a `relative` container and put the chip there once:

```html
  <div class="relative w-full">
    @if (product().image; as image) {
      <img
        [src]="image.uri"
        [alt]="product().name"
        class="h-75 w-full shrink-0 rounded-md object-cover"
      />
    } @else {
      <!-- WHY: The design has no frame for a product without artwork. A bare
           surface reads as a failed image load beside cards that do have one, so
           the state is labelled rather than left blank. -->
      <div
        class="bg-surface-subtle flex h-75 w-full shrink-0 flex-col items-center justify-center gap-sm rounded-md"
      >
        <svg lucideImageOff class="text-ink-muted h-icon-lg w-icon-lg"></svg>
        <span class="text-ink-muted text-body-sm">No image</span>
      </div>
    }
    <!-- WHY: Rendered always and revealed by a class, never created by an @if.
         An element inserted at the moment it should animate has no previous
         state to transition from, so the fade and the sheen never play. -->
    <span
      class="in-cart-chip bg-surface-white text-ink-primary absolute top-3 left-3 flex h-fit w-fit flex-row items-center justify-start gap-2xs overflow-hidden rounded-full px-2xl py-sm text-micro font-semibold shadow-sm"
      [class.is-shown]="inCart()"
      [attr.aria-hidden]="!inCart()"
    >
      <svg lucideCheck class="text-success-green h-icon-2xs w-icon-2xs"></svg>
      In cart
    </span>
  </div>
```

Then replace the price row's `@else` branch with the morph wrapper:

```html
  <div class="flex h-10 w-full shrink-0 flex-row items-center justify-between">
    <span class="text-ink-primary text-lg font-bold tracking-[-0.01875rem]">{{ price() }}</span>
    @if (outOfStock() && !inCart()) {
      <span class="text-danger-red text-xs font-semibold">Out of stock</span>
    } @else {
      <div class="qty-morph shrink-0" [class.in-cart]="inCart()">
        <button
          type="button"
          data-testid="product-card-add"
          class="qty-morph__add text-surface-white flex flex-row items-center justify-center gap-sm text-sm font-semibold"
          [attr.aria-label]="'Add ' + product().name + ' to cart'"
          (click)="onAdd()"
        >
          <svg lucidePlus class="h-4 w-4"></svg>
          Add
        </button>
        <app-qty-stepper
          class="qty-morph__stepper"
          [quantity]="quantity()"
          [canIncrement]="canIncrement()"
          [itemName]="product().name"
          (increment)="onIncrement()"
          (decrement)="onDecrement()"
          (removed)="onRemove()"
        />
        <svg class="qty-morph__trace" aria-hidden="true"><rect pathLength="1" /></svg>
      </div>
    }
  </div>
```

- [x] **Step 5: Drop the removed output at the call site**

In `apps/web/src/app/features/catalogue/home.html:86`, change:

```html
          <app-product-card [product]="product" (add)="addToCart(product.id)" />
```

to:

```html
          <app-product-card [product]="product" />
```

In `apps/web/src/app/features/catalogue/home.ts`, delete the `addToCart` method and its doc comment, and remove the now-unused `CartStore` import and `private readonly cart = inject(CartStore);` field. Verify nothing else in the file uses `this.cart`:

```bash
grep -n "this.cart" apps/web/src/app/features/catalogue/home.ts
```
Expected: no matches.

- [x] **Step 6: Adapt `home.spec.ts`**

Run the suite first and read the failures rather than guessing which assertions moved:

Run: `nvm use && pnpm web:test -- --include 'src/app/features/catalogue/home.spec.ts'`

Fix only what broke because `addToCart` and the `(add)` binding are gone. Do not weaken an assertion to make it pass — if a test asserted the card emitted `add`, it now belongs in `product-card.spec.ts`, where Task 4 Step 1 already covers it.

- [x] **Step 7: Run the full suite**

Run: `nvm use && pnpm web:test`
Expected: PASS, with the new `product-card` and `qty-stepper` files included.

- [x] **Step 8: Verify the golden rules**

```bash
grep -rnE '(bg|text|border)-\[#' apps/web/src/
```
Expected: no matches.

Run: `nvm use && pnpm web:lint && pnpm web:typecheck && pnpm web:build`
Expected: all clean, bundle budget respected.

- [x] **Step 9: Stage, and present the commit for confirmation**

```bash
git add apps/web/src/app/shared/ui/product-card.ts \
        apps/web/src/app/shared/ui/product-card.html \
        apps/web/src/app/shared/ui/product-card.spec.ts \
        apps/web/src/app/features/catalogue/home.html \
        apps/web/src/app/features/catalogue/home.ts \
        apps/web/src/app/features/catalogue/home.spec.ts
```

Proposed message — do NOT commit without confirmation:
```
feat(web): morph the product card's Add button into the quantity stepper

Spec: docs/superpowers/specs/2026-09-30-cart-add-quantity-morph-design.md
Plan: docs/superpowers/plans/2026-09-30-cart-add-quantity-morph.md
```

---

### Task 5: `CartLine` adopts the shared stepper

**Files:**
- Modify: `apps/web/src/app/shared/ui/cart-line.html:28-62`
- Modify: `apps/web/src/app/shared/ui/cart-line.ts`
- Test: `apps/web/src/app/shared/ui/cart-line.spec.ts`
- Test: `apps/web/src/app/features/cart/cart-drawer.spec.ts` (verify, do not rewrite)

**Interfaces:**
- Consumes: `QtyStepper` from Task 1.
- Produces: `CartLine` with its public API unchanged — inputs `line`, `readonlyQuantity`, `disabled`; outputs `increment`, `decrement`, `removed`. `cart-drawer.html` and `checkout-payment.html` are untouched.

- [x] **Step 1: Replace the inline stepper**

In `apps/web/src/app/shared/ui/cart-line.html`, the `@else` branch currently holds a hand-built stepper. Replace the whole `@else { ... }` body with:

```html
      } @else {
        <app-qty-stepper
          [quantity]="quantity()"
          [canIncrement]="canIncrement()"
          [disabled]="disabled()"
          [itemName]="name()"
          (increment)="increment.emit()"
          (decrement)="decrement.emit()"
          (removed)="removed.emit()"
        />
      }
```

The `WHY:` comment about removal at quantity 1 moves with the behaviour — it now lives on `QtyStepper.onDecrease` (written in Task 1), so delete it here rather than duplicating it.

- [x] **Step 2: Update the imports**

In `apps/web/src/app/shared/ui/cart-line.ts`, add `QtyStepper` and drop `LucideMinus` and `LucidePlus` (the template no longer draws them; `LucideTriangleAlert` stays for the unavailable badge):

```ts
import { LucideTriangleAlert } from '@lucide/angular';
import { QtyStepper } from './qty-stepper';
```

and in the decorator: `imports: [LucideTriangleAlert, QtyStepper],`.

- [x] **Step 3: Run the cart-line suite and read the failures**

Run: `nvm use && pnpm web:test -- --include 'src/app/shared/ui/cart-line.spec.ts'`

Expect breakage only where a test reached into the old markup. Fix the selectors, not the assertions. The quantity test must keep resolving `[data-testid="cart-line-quantity"]`, which Task 1's template preserves.

- [x] **Step 4: Verify the drawer suite still passes untouched**

Run: `nvm use && pnpm web:test -- --include 'src/app/features/cart/cart-drawer.spec.ts'`
Expected: PASS with NO edits to `cart-drawer.spec.ts`. That suite locates keys by `[aria-label="Increase quantity"]` and `[aria-label="Decrease quantity"]`, which Task 1 preserves verbatim.

If it fails, the `aria-label` contract was broken in Task 1 — fix the stepper, not this spec.

- [x] **Step 5: Confirm the checkout summary is unaffected**

`checkout-payment.html:480` mounts `<app-cart-line [line]="line" [readonlyQuantity]="true" />`, which renders the "Qty N" text branch and no stepper. So the 34px→40px growth touches the cart drawer only, not the Order Summary.

Run: `nvm use && pnpm web:test -- --include 'src/app/features/checkout/checkout-payment.spec.ts'`
Expected: PASS, untouched.

- [x] **Step 6: Run the full gate**

Run: `nvm use && pnpm web:test && pnpm web:lint && pnpm web:typecheck && pnpm web:build`
Expected: all clean.

- [x] **Step 7: Stage, and present the commit for confirmation**

```bash
git add apps/web/src/app/shared/ui/cart-line.html \
        apps/web/src/app/shared/ui/cart-line.ts \
        apps/web/src/app/shared/ui/cart-line.spec.ts
```

Proposed message — do NOT commit without confirmation:
```
refactor(web): mount the shared stepper in the cart line

Spec: docs/superpowers/specs/2026-09-30-cart-add-quantity-morph-design.md
Plan: docs/superpowers/plans/2026-09-30-cart-add-quantity-morph.md
```

---

### Task 6: The `.pen` trash icon

**Files:**
- Modify: `assets/web-app/web-app.pen` (component `a7S8KL`, key `pZx5L`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing code depends on. This closes the design/code gap Task 1 already implemented.

- [x] **Step 1: Read the current state of the key**

Over the Pencil MCP (`get_app_state` first, with all three flags, per [[pencil-design-extraction]]):

```js
Print(JSON.stringify(Get("pZx5L", { resolveVariables: true }), null, 1));
```

Expected: one `icon` child, `qt3sI`, `icon: "minus"`, `fill: "#6B7280"`.

- [x] **Step 2: Add the trash glyph beside the minus**

```js
Insert("pZx5L", {
  type: "icon",
  name: "Remove Icon",
  width: 16,
  height: 16,
  icon: "trash-2",
  library: "lucide",
  fill: "$text-secondary",
  layoutPosition: "absolute",
});
```

Then confirm both glyphs are present:

```js
Get("pZx5L", (n, ctx) => Print("  ".repeat(ctx.depth) + n.type + " " + n.id + " " + (n.icon ?? n.name)));
```

- [x] **Step 3: Ask the user to save, then verify on disk**

An MCP edit lives in the open editor's memory only. Tell the user the `.pen` needs saving in the desktop app, then verify:

```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
echo "disk: $(git hash-object assets/web-app/web-app.pen)"
echo "HEAD: $(git rev-parse HEAD:assets/web-app/web-app.pen)"
```

Equal hashes mean the save has not landed — do NOT report this task done on the strength of the MCP call alone. See quirk 6 in [[pencil-design-extraction]].

- [ ] **Step 4: Re-export the affected frames**

`apps/web/design/exports/cart-line.html` ALREADY EXISTS and is tracked, so this step REPLACES a committed file rather than creating one. `product-card-add-to-cart-states.html` is likewise already tracked (committed in `6141f814`).

```js
base = "/Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/apps/web/design/exports/";
Export(["N3ZlMt"], "html-tailwind", base + "product-card-add-to-cart-states.html", { includeLayerNames: true });
Export(["L5XVFs"], "html-tailwind", base + "cart-line.html", { includeLayerNames: true });
Print("re-exported");
```

`outputPath` must be absolute — a relative one resolves against the `.pen`'s own directory.

- [ ] **Step 5: Stage, and present the commit for confirmation**

```bash
git add assets/web-app/web-app.pen apps/web/design/exports/
```

Proposed message — do NOT commit without confirmation:
```
feat(web): draw the stepper's remove glyph in the design file

Spec: docs/superpowers/specs/2026-09-30-cart-add-quantity-morph-design.md
Plan: docs/superpowers/plans/2026-09-30-cart-add-quantity-morph.md
```

---

### Task 7: Documentation propagation and the gap audit

**Files:**
- Modify: `apps/web/DESIGN.md`
- Modify (via the `obsidian-vault` agent only): `docs/shared/conventions/angular-component-authoring.md`, `docs/shared/conventions/pencil-design-extraction.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the `propagates-to:` targets this plan and its spec declare.

- [ ] **Step 1: Update `apps/web/DESIGN.md`**

Add to the component table: `Qty Stepper` (`a7S8KL`) → `apps/web/src/app/shared/ui/qty-stepper.ts`. Add the three new frames to the frame listing: `N3ZlMt` (Product Card — Add to Cart States), `E9o3g` (Explore — Add Button & Qty Stepper), `ESRzy` (Explore — In Cart Indicator). Record that `Product Card` and `Cart Line` both instance the stepper.

This is the `code → docs` direction the gap audit says is most often skipped, and a doc keeping a value the code has corrected is worse than no doc.

- [ ] **Step 2: Propagate the reusable rules through `obsidian-vault`**

Route these edits through the `obsidian-vault` agent — it is the sole writer of `docs/`:
- `[[angular-component-authoring]]`: the control-versus-behaviour split (a shared control receives its constraints rather than deriving them), and the CSS-first motion rule with `element.animate()` reserved for cases needing two live nodes.
- `[[pencil-design-extraction]]`: that a `.pen` reusable component maps to one `shared/ui` component, and the unsaved-file verification step.

Bump each target's `updated:` and add the bidirectional `## Related` links.

- [ ] **Step 3: Validate the vault**

Run from the repo root: `nvm use && node scripts/validate-vault.mjs`
Expected: passes, with no broken wikilinks and the propagation gate green.

- [ ] **Step 4: Run the gap audit**

Invoke the `spec-implementation-audit` skill against this plan and its spec. It is a gate, not a suggestion, and it audits three directions: spec → code, code → docs, and plan → repo. Re-run it after closing any gap, since closing one routinely reveals another.

A gap that is a real code defect rather than doc drift gets its own change and its own review — never a silent fix inside this propagation pass.

- [ ] **Step 5: Stage, and present the commit for confirmation**

```bash
git add apps/web/DESIGN.md docs/
```

Proposed message — do NOT commit without confirmation:
```
docs(vault): propagate the shared stepper and morph decisions

Spec: docs/superpowers/specs/2026-09-30-cart-add-quantity-morph-design.md
Plan: docs/superpowers/plans/2026-09-30-cart-add-quantity-morph.md
```

---

## Manual verification

Automated tests do not cover motion, so verify these by hand before proposing the PR. Run `pnpm web:dev` from the repo root for the fast edit loop (ng serve with HMR), which is what `docker-compose.yml` itself recommends for editing, against a running local stack; the containerised web service comes up with `make up` instead, and needs `docker compose build web` after a change rather than a restart.

- [ ] Clicking Add morphs the button in place: navy fades to white, the border traces itself, then settles grey. No jump, no flash.
- [ ] The "In cart" chip fades down onto the image corner, and one green sheen crosses it. It does NOT replay on later quantity changes.
- [ ] `+` rolls the counter upward; `−` rolls it downward.
- [ ] At quantity 1 the left key shows a trash icon; at 2 it shows `−`; crossing that boundary crossfades rather than flickering.
- [ ] Removing the last unit morphs the control back to Add and the chip fades out.
- [ ] The cart drawer's stepper is visually identical to the card's resting state, now 40px tall.
- [ ] With `prefers-reduced-motion: reduce` set in the OS, states change with a plain fade: no trace, no sheen, no roll.
- [ ] A product in the cart that goes out of stock keeps its stepper with `+` disabled and `−` working.
- [ ] Verify the add flow still appears in the OpenObserve viewer — the card calls the store, which uses `ApiClient`, so the span and `traceparent` survive. Silence means the interceptor was bypassed. See [[browser-rum]].

## Related

- [[2026-09-30-cart-add-quantity-morph-design]] — the spec this plan implements.
- [[2026-09-04-web-gateway-integration-design]] — where the CartStore's optimistic-overlay and debounce CONTRACTs were decided.
- [[2026-09-04-angular-http-testing-traps]] — the fake-timers/`settle()` trap `flushDebounce` exists to avoid.
- [[angular-component-authoring]] — `.html` templates, `rem` not `px`, and the rules this plan propagates into.
- [[pencil-design-extraction]] — reading the `.pen`, the absolute-path export quirk, and the unsaved-file check.
- [[code-comments]] — the five tags and present-tense rule every comment above follows.
- [[testing]] — why no new E2E layer applies to a change that adds no endpoint.
- [[money-representation]] — why `quantity` and `unitsInStock` need `toInt` before comparison.
- [[browser-rum]] — the observability check in manual verification.
- [[git-workflow]] — the A/B/C/D/E confirmation every commit step defers to.
- [[doc-propagation]] — the routing this plan's Task 7 follows.
