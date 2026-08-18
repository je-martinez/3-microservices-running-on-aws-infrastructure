import { Component, input, output } from '@angular/core';
import { LucideBell, LucideSearch, LucideShoppingBag, LucideUser } from '@lucide/angular';
import { LogoLockup } from '../../shared/ui/logo-lockup';

/**
 * Design: merges `App Header` (EMNqu, 1440 desktop) and `Mobile App Header`
 * (fguH5, 390 mobile) into one responsive component per spec D8 — two
 * components here would double the count and guarantee divergence.
 *
 * Differences the `md:` breakpoint carries:
 *   - height 60px mobile -> 76px desktop; side padding 20px -> 48px.
 *   - icon buttons 40x40 mobile -> 44x44 desktop.
 *   - desktop shows the full "Search products" field (260x44); mobile
 *     collapses it to a bare search icon button (40x40) — same Search Icon
 *     glyph, no visible field or placeholder text on the smaller frame.
 *
 * Neither EMNqu nor fguH5 contains a hamburger/"Menu Sheet" trigger node —
 * both expose the same four actions (search, bell, profile, cart). No such
 * button is fabricated here; see the task report.
 */
@Component({
  selector: 'app-app-header',
  imports: [LogoLockup, LucideBell, LucideSearch, LucideShoppingBag, LucideUser],
  template: `
    <header
      class="border-line bg-surface-white flex h-[60px] w-full items-center justify-between border-b px-5 md:h-[76px] md:px-12"
    >
      <div class="flex items-center gap-10">
        <app-logo-lockup />
      </div>

      <div class="flex items-center gap-[10px] md:gap-[14px]">
        <!-- Desktop: full search field. -->
        <div
          class="border-line bg-surface-subtle hidden h-[44px] w-[260px] items-center gap-[10px] rounded-md border px-[14px] md:flex"
        >
          <svg lucideSearch class="text-ink-muted text-[17px]"></svg>
          <span class="text-ink-muted text-sm">Search products</span>
        </div>

        <!-- Mobile: icon-only search button. -->
        <button
          type="button"
          class="border-line text-brand-navy flex h-[40px] w-[40px] items-center justify-center rounded-md border md:hidden"
          (click)="searchClicked.emit()"
        >
          <svg lucideSearch class="text-[18px]"></svg>
        </button>

        <button
          type="button"
          class="border-line text-brand-navy relative flex h-[40px] w-[40px] items-center justify-center rounded-md border md:h-[44px] md:w-[44px]"
          (click)="notificationsClicked.emit()"
        >
          <svg lucideBell class="text-[18px] md:text-[19px]"></svg>
          @if (hasUnreadNotifications()) {
            <span
              class="bg-brand-orange border-surface-white absolute top-[7px] right-[7px] h-[9px] w-[9px] rounded-full border-[1.5px] md:top-[9px] md:right-[9px]"
            ></span>
          }
        </button>

        <button
          type="button"
          class="border-line text-brand-navy flex h-[40px] w-[40px] items-center justify-center rounded-md border md:h-[44px] md:w-[44px]"
          (click)="profileClicked.emit()"
        >
          <svg lucideUser class="text-[18px] md:text-[19px]"></svg>
        </button>

        <button
          type="button"
          class="bg-brand-navy text-surface-white flex h-[40px] items-center gap-2 rounded-md px-[14px] text-sm font-semibold md:h-[44px] md:gap-[9px] md:px-4"
          (click)="cartClicked.emit()"
        >
          <svg lucideShoppingBag class="text-[17px] md:text-[18px]"></svg>
          {{ cartCount() }}
        </button>
      </div>
    </header>
  `,
})
export class AppHeader {
  readonly cartCount = input(0);
  readonly hasUnreadNotifications = input(false);

  readonly searchClicked = output<void>();
  readonly notificationsClicked = output<void>();
  readonly profileClicked = output<void>();
  readonly cartClicked = output<void>();
}
