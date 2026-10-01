---
title: "Cart Add-to-Cart Morph and Shared Quantity Stepper Design"
type: spec
area: shared
status: draft
created: 2026-09-30
updated: 2026-09-30
tags:
  - type/spec
  - area/shared
  - status/draft
related:
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[pencil-design-extraction]]"
  - "[[angular-component-authoring]]"
  - "[[code-comments]]"
  - "[[money-representation]]"
  - "[[browser-rum]]"
  - "[[testing]]"
  - "[[2026-09-04-angular-http-testing-traps]]"
propagates-to:
  - "[[angular-component-authoring]]"
  - "[[pencil-design-extraction]]"
---

# Cart Add-to-Cart Morph and Shared Quantity Stepper Design

Web app only (`apps/web/`: Angular 22, NgRx Signals 22, Tailwind v4). Branch
`feature/cart-add-quantity-morph`. Every decision below was brainstormed and approved by the
user one at a time; this note records them as settled.

## Context

Adding a product from the Home catalogue grid gives no feedback today: the navy "Add" button
does nothing visible. The goal:

- The Add button morphs in place into a quantity stepper.
- An "In cart" chip appears on the product image corner when the product first enters the cart (0 to 1).
- The quantity stepper is **one shared component** used by both the Home grid and the Cart drawer.

## Design sources

All already exist; none are invented here.

- `.pen` frames (`assets/web-app/web-app.pen`, read live over the Pencil MCP, see [[pencil-design-extraction]]):
  - `N3ZlMt` "Product Card — Add to Cart States": four states (default, qty 1, qty >1, mobile compact).
  - `E9o3g` "Explore — Add Button & Qty Stepper": 11 options. **Option G is marked `✓ Selected`**: "Solid button to outline stepper". The filled Add calms down once done, and the stepper matches the cart drawer's, so it is the same control everywhere.
  - `ESRzy` "Explore — In Cart Indicator": 6 options. **Option A chosen**: white chip with a check, top-left of the image. "Neutral, reads on any photo. Says state, not quantity."
  - `a7S8KL` "Qty Stepper": a NEW reusable `.pen` component, already instanced by both `Product Card` (`QmNIg`) and `Cart Line` (`L5XVFs`).
- HTML exports in `apps/web/design/exports/` (written on this branch, not yet committed): `product-card-add-to-cart-states.html`, `explore-add-button-and-qty-stepper.html`, `explore-in-cart-indicator.html`.
- Motion prototype: `assets/web-app/prototypes/add-to-cart-morph.html`, variant **19 · Fade + sheen** = CSS classes `.v10` (button) + `.c19` (chip).

## Decisions

1. **Motion = variant 19.** `v10` button plus `c19` chip.
2. **Indicator = Option A.** White pill chip, green check, text "In cart" (no quantity), top-left of the image. It appears on 0 to 1 and **persists** while qty is 1 or more; it is not a flash. The sheen plays once.
3. **Trash at qty 1.** The left key shows a trash icon at qty 1, morphing to `−` at qty >1. This requires ADDING the trash icon to the `.pen` component `a7S8KL`, which today draws `minus` only.
4. **Sizing from the `.pen`.** Stepper 40px tall (`h-10`); keys 34px wide (`w-control-sm`); counter 30px wide, 14px semibold; icons 16px (`h-4 w-4`); background `surface-white`; border `line-strong` 1px; `rounded-lg`. The `−` is `ink-secondary`, the `+` is `ink-primary`. This GROWS the cart's stepper from its current 34px (`h-control-sm`) to 40px, which visibly changes the Cart drawer only. The Checkout Order Summary is unaffected: it mounts `CartLine` with `readonlyQuantity` true, which renders a "Qty N" text branch and no stepper.
5. **Separation of concerns.** `QtyStepper` is the control only; the morph lives in `ProductCard`. The cart drawer's stepper is born visible and must not carry the Add-button state machine it never runs.
6. **The product card reads the store itself.** It injects `CartStore` and derives its own quantity. Its `add` output is REMOVED, and `addToCart()` disappears from `home.ts`.
7. **Optimistic add, no spinner.** The stepper appears immediately off the store's optimistic overlay. A failed PUT reverts via the store and the stepper morphs back. (The optimistic-overlay and debounce CONTRACTs were decided in [[2026-09-04-web-gateway-integration-design]].)
8. **Sheen tint via `color-mix`.** `color-mix(in srgb, var(--color-success-green) 25%, transparent)`. NO new `.pen` variable: the prototype's raw `#10B98140` is `success-green` at 25% alpha, and all 32 `.pen` variables already exist in `styles.css`, so this is the only colour gap and it is derived, not hand-written.
9. **Implementation approach = CSS-driven (Approach A)**, with ONE exception: the rolling counter uses `element.animate()` inside `QtyStepper`, because it needs two simultaneous nodes (old leaving, new entering) and CSS alone would duplicate the markup. Explicitly REJECTED: adding `@angular/animations`. It is not a dependency today, the bundle-budget gate is real, it cannot animate SVG `stroke-dashoffset` anyway (so motion would end up in two languages), and the package is in maintenance mode.
10. **Parameterized selector plus index in the store** (performance). A naive `lines().find(...)` per card is O(n) per card, so the whole grid is O(n·m) on every cart change. Add to the store's `withComputed`:
    - `quantityByProduct`: a `computed` building a `Map<string, number>` from `lines()` ONCE per change.
    - `quantityOf`: a `computed` returning a lookup function `(productId: string) => number`, 0 when absent.

    The card reads `this.cart.quantityOf()(this.product().id)`. Cost goes from O(n·m) to O(n) for the index plus O(1) per card.

    **Honest limitation:** this does NOT reduce the NUMBER of revalidations. Every card's computed still depends on `quantityOf`, which changes when any line changes; what gets cheaper is the work each card does. A per-product `Map<string, Signal<number>>` would cut revalidations too, and was deliberately deferred as premature with 8 products. It can be added later without changing the card's `quantity` surface.

11. **`QtyStepper` takes four flat inputs, not one config object.** The four inputs are `quantity`, `canIncrement`, `disabled` and `itemName`. Encapsulating them in a single object inside a signal was considered and REJECTED, for four reasons:
    1. **It loses fine-grained updates.** Today a change to `quantity` only invalidates what depends on `quantity`. With one object, any field's change invalidates the whole input: the `aria-label` recomputes because stock moved, and the `canIncrement` check reruns because the name changed. That is the opposite of the indexing optimisation Decision 10 adds to the store.
    2. **It makes correctness depend on reference identity.** An object input needs the caller to preserve the reference. In `cart-line` it would come from a `computed`, which memoises, so that is fine. In `product-card`, an object literal written inline in the template allocates a new object on every change-detection cycle, and under `OnPush` that triggers work that does not exist today. The failure is silent: nothing breaks, it just recomputes.
    3. **It defeats `input.required`.** Forgetting `quantity` is a compile error today. Inside an object, forgetting a field is caught only if the type demands it, and the optional fields lose their defaults: each read would need a `??`, or both callers would have to construct the object in full.
    4. **The defaults are the strongest reason.** `canIncrement = input(true)` means a stepper with unknown stock CAN increment. With an object, `config().canIncrement` is `undefined` when the caller omits it, and `undefined` is falsy, so the `+` key would be dead by omission. That is a defect that passes review.

    **When grouping WOULD be justified, and why it does not apply.** Grouping expresses that fields form one coherent state that changes together. Here the four come from four different sources that change at different times: `quantity` from the cart, `canIncrement` from stock, `itemName` from the product, `disabled` from the store's saving state.

    **Adjacent alternative, also deferred: pass `maxQuantity` instead of `canIncrement`.** The stepper would derive the comparison itself, which removes one input and puts the rule in one place. It was rejected for the same reason as Decision 5: the stepper would start knowing about stock, and the two sources (a cart line's `unitsInStock` versus a product's) carry different semantics the control must not choose between.

## Motion specification

Ported from the prototype.

**Button, `v10` "Outline draws in":**

- Fill navy to white, 200ms ease.
- A navy 1.5px stroke traces the border: `<svg><rect pathLength="1">` with `stroke-dashoffset` 1 to 0, 460ms `cubic-bezier(.65,0,.35,1)`.
- Then it settles to `line-strong` 1px, 300ms, delayed +460ms.
- Width 84 to 100px, 300ms `cubic-bezier(.2,.8,.2,1)`.
- "Add" label out in 100ms (on the way back, in with +300ms delay).
- Stepper keys in 120ms, delayed +200ms.

**Chip, `c19` "Fade + sheen":**

- Fade plus 3px drop, 420ms `cubic-bezier(.22,1,.36,1)`, delayed +160ms.
- Sheen: 105deg linear-gradient sweep left to right, 900ms `cubic-bezier(.4,0,.2,1)`, delayed +420ms, plays ONCE (`@keyframes` from `background-position:130% 0` to `-30% 0`).

**Shared:**

- Trash and `−` crossfade on the left key: both glyphs stacked, opacity plus transform, 160ms.
- The counter rolls vertically on change, 200ms `cubic-bezier(.2,.8,.2,1)`; direction follows increase or decrease.
- `prefers-reduced-motion`: everything collapses to a 120ms opacity fade. No transforms, no border trace, no sheen (ported from the prototype's `body.rm` rule).

## Component design

### `QtyStepper` (NEW)

`apps/web/src/app/shared/ui/qty-stepper.{ts,html}`. The control only: injects nothing, no network.

```ts
quantity     = input.required<number>();
canIncrement = input(true);
disabled     = input(false);
itemName     = input('');          // builds the left key's aria-label
decrement    = output<void>();     // qty > 1
increment    = output<void>();
removed      = output<void>();     // qty === 1 (the trash)
```

- The stepper does NOT derive `canIncrement` from stock; it receives it. `cart-line` computes it from the line's `unitsInStock` and `product-card` from the product's: two different sources the control should know nothing about.
- Likewise the trash threshold: at `quantity() === 1` the left key emits `removed` instead of `decrement`. This is the rule `cart-line` already enforces today (the server has no per-line DELETE, so a stepper that stops at 1 leaves no way to remove an item).
- Accessibility: the left key's `aria-label` alternates between `Remove <itemName>` and `Decrease quantity`; the counter carries `aria-live="polite"`.

### `ProductCard` changes

- Injects `CartStore`; `quantity` and `inCart` are computed from `quantityOf`.
- The `add` output is removed. The card calls `cart.add(id)`, `cart.adjustQuantity(id, n)` and `cart.remove(id)` directly. Rationale: the store's CONTRACTs ("steppers use `adjustQuantity`, never `setQuantity`"; "always `CartStore`, never `CartApi`") are easier to honour from one place than from every page mounting a card.
- Template: a `relative h-10` wrapper with `[class.in-cart]="inCart()"` holding the Add button, `<app-qty-stepper>`, and the tracing `<svg>`.
- The chip is positioned `top-3 left-3` on the image.
- **Out of stock:** if `unitsInStock === 0` AND the product is not in the cart, keep today's "Out of stock" text instead of the control. If it IS in the cart and stock runs out, the stepper must stay visible with `canIncrement` false; otherwise the buyer loses the only way to remove it.

### `CartLine` changes

Drops its ~35-line inline stepper block and mounts `<app-qty-stepper>`. Its three outputs (`increment`, `decrement`, `removed`) wire straight through, so its public API is unchanged and `cart-drawer` and `checkout-payment` are untouched. `canIncrement` keeps being computed in `cart-line` against `unitsInStock`.

### `.pen` change

Add a `trash-2` lucide icon to `a7S8KL`'s left key, stacked with the existing `minus`. Per the pencil skill's quirk 6, a successful MCP call does NOT mean the file changed on disk. Verify with `git hash-object assets/web-app/web-app.pen` against `git rev-parse HEAD:assets/web-app/web-app.pen`, and note that the user must save in the desktop app.

## Testing

- `qty-stepper.spec.ts` (new): emits `removed` at qty 1 and `decrement` at qty >1; `increment` blocked when `canIncrement` is false; inert when `disabled`.
- `product-card.spec.ts` (new; does not exist today): uses the REAL `CartStore` with `provideHttpClient()` + `provideHttpClientTesting()`, following `cart-drawer.spec.ts` and `home.spec.ts`, and drives it through `HttpTestingController` expectations. Cases: qty 0 renders the Add button and no chip; after adding, the stepper and the chip render; out-of-stock with qty >0 still renders the stepper with the `+` disabled. Quantity changes go through a `flushDebounce()`-style helper (`vi.advanceTimersByTime(500)`, then `vi.useRealTimers()`, then `await settle(fixture)`) because the store coalesces clicks over 350ms; real timers must be restored before pumping, since `settle()` awaits a `setTimeout` of its own and under fake timers nothing advances it, so the test hangs and reports a stall instead of the missing PUT the assertion is about (see [[2026-09-04-angular-http-testing-traps]]). Faking the store was considered and rejected: no spec in the app does it, and a fake would bypass the optimistic overlay and the debounce queue, which are precisely the mechanics the card's quantity depends on.
- `cart-line.spec.ts`: adapt to the new markup; verify `data-testid="cart-line-quantity"` still resolves (it moves into `QtyStepper`).
- `home.spec.ts`: adapt, since `addToCart` is gone.
- The stepper's `aria-label`s are a test contract, not an implementation detail: existing cart specs locate the keys by `[aria-label="Increase quantity"]` and `[aria-label="Decrease quantity"]`, so `QtyStepper` must keep emitting exactly those strings, plus the left key's `Remove <itemName>` form at qty 1. Changing any of them breaks `cart-drawer.spec.ts`.
- No motion assertions: it is CSS, and a transition test breaks on every curve tweak.
- No new E2E: the three-layer convention in [[testing]] governs HTTP endpoints, and this change adds none.
- `pnpm build` is part of "done": the initial-bundle budget is a real gate that `test`, `lint` and `typecheck` do not check.

## Documentation follow-up (code to docs)

`apps/web/DESIGN.md` (a repo file, not a vault note) must be updated with the three new frames (`N3ZlMt`, `E9o3g`, `ESRzy`) and the `Qty Stepper` (`a7S8KL`) to component-path mapping (`apps/web/src/app/shared/ui/qty-stepper.ts`). This is the `code → docs` direction the gap audit says is most often skipped. The `propagates-to:` targets receive the reusable rules: [[angular-component-authoring]] gets the control-versus-behaviour split and the CSS-first motion rule (`element.animate()` only when two live nodes are needed); [[pencil-design-extraction]] gets the `.pen` component to code mapping and the unsaved-file verification step.

## Out of scope

Other prototype variants the user did not pick: fly-to-cart thumbnail, Undo toast, header cart-badge bump, the pending-spinner variant (8), and indicator options B to F.

## Related

- [[2026-09-04-web-gateway-integration-design]]: where the CartStore's optimistic-overlay and debounce CONTRACTs were decided.
- [[pencil-design-extraction]]: how the `.pen` frames and components are read and translated.
- [[angular-component-authoring]]: component conventions the new `QtyStepper` follows.
- [[code-comments]]: comment tags and tense rules for the new CSS and component code.
- [[money-representation]]: unchanged here; listed because the card keeps rendering prices through it.
- [[browser-rum]]: the card calls the store (which uses `ApiClient`), so the add flow stays observable.
- [[testing]]: three-layer rule and why no new E2E applies.
- [[2026-09-04-angular-http-testing-traps]]: the fake-timers/`settle()` trap the quantity tests must avoid.
