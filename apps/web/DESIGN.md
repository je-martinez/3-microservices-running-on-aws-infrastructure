# 3MRAI Web App — Design System

Design source: `assets/web-app/web-app.pen`

## Design Tokens

`GetVariables()` returned exactly 26 variables (read live from the `.pen`, 2026-08-18). 11 were renamed on emission into `apps/web/src/styles.css` to avoid Tailwind v4 utility stutter (e.g. `bg-body` would otherwise collide with a `bg-*` utility named `bg-bg-body`). Everything else maps straight through.

| `.pen` name | Value | Tailwind utility |
|---|---|---|
| `brand-navy` | `#2D3748` | `bg-brand-navy` |
| `brand-navy-deep` | `#1F2733` | `bg-brand-navy-deep` |
| `brand-orange` | `#F7941D` | `bg-brand-orange` |
| `brand-orange-light` | `#FFF4E5` | `bg-brand-orange-light` |
| `brand-orange-text` | `#C2710E` | `text-brand-orange-text` |
| `bg-body` | `#F4F4F5` | `bg-surface-body` |
| `bg-white` | `#FFFFFF` | `bg-surface-white` |
| `bg-subtle` | `#FAFAFA` | `bg-surface-subtle` |
| `text-primary` | `#1A1A2E` | `text-ink-primary` |
| `text-secondary` | `#6B7280` | `text-ink-secondary` |
| `text-muted` | `#9CA3AF` | `text-ink-muted` |
| `text-on-dark` | `#E8EAEE` | `text-ink-on-dark` |
| `border-color` | `#E5E7EB` | `border-line` |
| `border-strong` | `#D1D5DB` | `border-line-strong` |
| `success-green` | `#10B981` | `bg-success-green` |
| `success-bg` | `#ECFDF5` | `bg-success-bg` |
| `success-text` | `#047857` | `text-success-ink` |
| `danger-red` | `#DC2626` | `text-danger-red` |
| `info-blue` | `#2563EB` | `text-info-blue` |
| `info-bg` | `#EFF6FF` | `bg-info-bg` |
| `warn-text` | `#B45309` | `text-warn-ink` |
| `warn-bg` | `#FFF7ED` | `bg-warn-bg` |
| `font-heading` | `Inter` | `font-heading` |
| `font-body` | `Inter` | `font-body` |
| `radius-md` | `10px` | `rounded-md` |
| `field-height` | `56px` | `h-field` |

Renamed on emission (`.pen` name → `styles.css` variable → utility): `bg-body` → `--color-surface-body` → `bg-surface-body`; `bg-white` → `--color-surface-white` → `bg-surface-white`; `bg-subtle` → `--color-surface-subtle` → `bg-surface-subtle`; `text-primary` → `--color-ink-primary` → `text-ink-primary`; `text-secondary` → `--color-ink-secondary` → `text-ink-secondary`; `text-muted` → `--color-ink-muted` → `text-ink-muted`; `text-on-dark` → `--color-ink-on-dark` → `text-ink-on-dark`; `border-color` → `--color-line` → `border-line`; `border-strong` → `--color-line-strong` → `border-line-strong`; `success-text` → `--color-success-ink` → `text-success-ink`; `warn-text` → `--color-warn-ink` → `text-warn-ink`.

Never use an arbitrary hex value (`bg-[#2D3748]`) in a component — always the token utility. `apps/web/src/styles.css` is the generated source of truth for these values; do not hand-edit it (re-run the `pencil-design-extraction` skill instead).

## Shared with the email templates

`brand-navy`, `brand-orange`, `text-primary`/`ink-primary`, `success-green` and the Inter font pairing are **identical** between this design system and [[email-templates]] (`assets/email/DESIGN.md`, sourced from `assets/email/emails.pen`). Web and email are two renderings of one brand, not two independent systems — changing a brand colour (or the type family) is a two-surface change: update both `.pen` files and re-run extraction on each, or the surfaces will visibly drift apart.

## Reusable components

20 root frames in the `.pen` are reusable components (verified live via `Get(document, …)`, 2026-08-18). Two more root frames — `Status Badge — States` (`UOHCo`) and `Tracking Status — Icons` (`hImQh`) — are variant sheets, not components themselves; they document the states of `Status Badge` and `Tracking Status Icon` below. One root frame, `Frame 800x600` (`bi8Au`), is empty scratch space and is not part of the design.

| Component | Node id | Target path | Inputs (where the design shows states) |
|---|---|---|---|
| Logo Lockup | `M8f7U` | `src/app/shared/ui/logo-lockup.ts` | — |
| Field | `TLRTA` | `src/app/shared/ui/field.ts` | — |
| Button Primary | `sHl96` | `src/app/shared/ui/button-primary.ts` | — |
| Button Ghost | `aUEDx` | `src/app/shared/ui/button-ghost.ts` | — |
| OTP Digit | `NZ7jF` | `src/app/shared/ui/otp-digit.ts` | — |
| Status Badge | `l7LGs` | `src/app/shared/ui/status-badge.ts` | `status: TrackingStatus`, states enumerated by `UOHCo` (`PLACED → PROCESSING → SHIPPED → OUT_FOR_DELIVERY → DELIVERED`) |
| Tracking Status Icon | `S59Ud1` | `src/app/shared/ui/tracking-status-icon.ts` | states enumerated by `hImQh` |
| Brand Panel | `WXmng` | `src/app/shared/ui/brand-panel.ts` | — |
| Mobile Brand Header | `u2nnov` | `src/app/shared/ui/mobile-brand-header.ts` | — |
| App Header | `EMNqu` (1440) + `fguH5` (390) | `src/app/core/layout/app-header.ts` | one responsive component merging both breakpoint frames; mobile's `Menu Sheet` trigger is an `output()` the shell binds |
| Product Card | `QmNIg` | `src/app/shared/ui/product-card.ts` | `product: Product` |
| Cart Line | `L5XVFs` | `src/app/shared/ui/cart-line.ts` | — |
| Cart Drawer | `ET6dr` | `src/app/features/cart/cart-drawer.ts` | `address: Address \| null`, `step: "cart" \| "payment"` — one component covers the saved-address (`wevx6`), no-address (`eig49`) and Stripe-payment (`hed4V`) frames |
| Account Menu | `B6fdc` | `src/app/features/account/account-menu.ts` | mounts off `OverlayStore`; covers `H2A9g`/`pD15E` |
| Order Card | `l6TyrG` (1040) + `tWTSZ` (342, Mobile Order Card) | `src/app/shared/ui/order-card.ts` | `entry: OrderWithTracking`, joined against `PRODUCTS` |
| Mobile App Header | `fguH5` | *(merged into App Header above)* | |
| Mobile Order Card | `tWTSZ` | *(merged into Order Card above)* | |
| Notification Item | `qwO6X` | `src/app/shared/ui/notification-item.ts` | — |
| Notifications Panel | `LWQ8g` | `src/app/features/notifications/notifications-panel.ts` | mounts off `OverlayStore`; one component reads each item's `read` flag to cover the Unread (`mSssa`) / Read (`YZIGp`) pair |
| Toast Notification | `jYz4h` | `src/app/shared/ui/toast-notification.ts` | covers `IQCEF`/`UpmOQ` |

Every component is `standalone: true` and uses `input()`/`output()` signals, never `@Input()`/`@Output()` decorators. Structure (flex layout, gaps, paddings) is legitimately copied from each frame's `apps/web/design/exports/<name>.html` export; arbitrary colour classes in that export (`bg-[#2D3748]`) are not — replace them with the matching token utility from the table above.

## Screens → routes

18 responsive screen pairs exist in the `.pen` (36 screen frames; the design spec's "39 screen frames" folds in the 2 variant sheets and the empty scratch frame). 11 of the 18 get a route; the other 7 render as overlay state on `/` (see below).

| Route | Screen frames (desktop / mobile) | Component |
|---|---|---|
| `/login` | `I4wRF` / `MnqTi` | `features/auth/login-password` |
| `/login/passwordless` | `j0sCI` / `drEOJ` | `features/auth/login-passwordless` |
| `/verify` | `V16TI` / `zouHC` | `features/auth/verify-code` |
| `/register` | `q52fsc` / `L4qQLy` | `features/auth/register-password` |
| `/register/passwordless` | `UK1Bu` / `t2OrS` | `features/auth/register-passwordless` |
| `/password/new` | `atwtV` / `G6lEnQ` | `features/auth/set-new-password` |
| `/` | `eK0x6` / `ffO4d` | `features/catalogue/home` |
| `/checkout` | `DOtD2` / `P0lhqj` | `features/checkout/checkout-payment` |
| `/orders` | `rGwBO` / `OoNex` | `features/orders/orders-list` |
| `/orders/:orderId` | `x7ABM` / `eq3Tk` | `features/orders/order-detail` |
| `/profile` | `hZ87b` / `nyVEI` | `features/account/profile` |
| `**` | — | redirect to `/` |

## Overlays are not routes

Four overlay components, covering seven of the eighteen screen pairs, are **not** in the route table above: Cart Drawer — 3 pairs (`wevx6`/`OIjLT` saved address, `eig49`/`KzgZN` no address, `hed4V`/`NfXeq` Stripe payment), Account Menu — 1 pair (`H2A9g`/`pD15E`), Notifications — 2 pairs (`mSssa`/`MP3DR` Unread, `YZIGp`/`b6S5Bl` Read), Toast — 1 pair (`IQCEF`/`UpmOQ`). 3+1+2+1 = 7, agreeing with the 11 routed + 7 overlay = 18 split above. This is verified, not assumed — inspecting each frame's children shows two distinct shapes:

```
Home — Products          [eK0x6] -> ref:App Header | frame:Body          ← real page
Checkout — Payment       [DOtD2] -> ref:App Header | frame:Body          ← real page
Home — Cart Open (saved) [wevx6] -> frame:Page | rectangle:Scrim | ref:Cart Drawer
Home — Account Menu      [H2A9g] -> frame:Page | ref:Account Menu
Home — Notifications     [mSssa] -> frame:Page | ref:Notifications Panel
Home — Cart Payment      [hed4V] -> frame:Page | rectangle:Scrim | ref:Cart Drawer — Payment
```

`Home — Products` and `Checkout — Payment` are `App Header` + `Body` — a real page. The four overlay frames instead wrap a bare `Page` plus an overlay (a `Scrim` rectangle for the cart, none for the menu/notifications panels). A frame whose first child is `Page` + an overlay is UI state layered over the catalogue route, not a destination of its own — so it gets no entry in `app.routes.ts`. `OverlayStore` (a single discriminated `active: OverlayKind` signal, not four booleans) models exactly this mutual exclusivity: the design never shows two overlays open at once.

## Assets

An export references images in three distinct ways — scanning only `<img>` tags misses the first, which is a CSS background:

| Kind | How it appears | Resolution |
|---|---|---|
| Local repo asset | `bg-[url('../img/standalone-logo.png')]`, relative to the `.pen` | Resolve against `assets/`, look the path up in `assets/assets.manifest.json` (keys are repo-relative), use the manifest's `url`. If missing: copy the file into `assets/web-app/` and run `make assets-sync`. |
| Inline Lucide icon | `data-icon-set="lucide"`, `data-icon-name="mail"` | Not an asset — nothing to sync. Render the named icon directly in the component; this is the web's advantage over email, where inline SVG is unusable and the same icons had to become PNGs in the bucket ([[email-templates]]). |
| Remote stock placeholder | an `images.unsplash.com` URL | Neither a repo asset nor final artwork. Do not copy it into `assets/` and do not ship a template hotlinking it in production. Render a token-coloured placeholder and flag the frame as needing real artwork. |

## Related

- [[email-templates]] — the sibling design system this one shares tokens with.
- `docs/superpowers/specs/2026-08-17-web-app-foundation-design.md` — the design spec this document distils.
