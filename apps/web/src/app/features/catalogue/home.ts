import { Component, computed, inject, signal } from '@angular/core';
import { LucideChevronDown, LucideRefreshCw, LucideTriangleAlert } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import { CatalogueApi } from '../../core/api/catalogue-api';
import type { Product } from '../../core/api/types';
import { SessionStore } from '../../core/auth/session-store';
import { CartStore } from '../../core/cart/cart-store';
import { OverlayStore } from '../../core/overlay/overlay-store';
import { authErrorMessage } from '../auth/auth-errors';
import { ProductCard } from '../../shared/ui/product-card';
import { CartDrawer } from '../cart/cart-drawer';

/**
 * Design: `Home — Products` (`eK0x6` desktop / `ffO4d` mobile). `CartDrawer`
 * mounts here off `OverlayStore.active()`; other panels mount in `Shell`.
 * Loading/error states use existing tokens: the `.pen` has no frame for either.
 * See [[pencil-design-extraction]]
 */
@Component({
  selector: 'app-home',
  imports: [CartDrawer, LucideChevronDown, LucideRefreshCw, LucideTriangleAlert, ProductCard],
  templateUrl: './home.html',
})
export class HomePage {
  private readonly catalogueApi = inject(CatalogueApi);
  private readonly session = inject(SessionStore);
  private readonly cart = inject(CartStore);

  protected readonly overlay = inject(OverlayStore);
  /**
   * CONTRACT: Derived from the loaded products, never a constant list. A
   * hardcoded one silently drops a category the catalogue gains — OUTERWEAR was
   * missing exactly that way, leaving its product unreachable by any chip.
   * `Product.categories` is an array, so this flattens rather than assuming one
   * per product. See [[2026-09-04-web-gateway-integration-design]]
   */
  protected readonly categories = computed(() =>
    [...new Set(this.products().flatMap((product) => product.categories))].sort(),
  );

  /** The chip in force, or null for "All". Holds the RAW wire value. */
  protected readonly selectedCategory = signal<string | null>(null);

  protected readonly visibleProducts = computed(() => {
    const category = this.selectedCategory();
    if (category === null) return this.products();
    return this.products().filter((product) => product.categories.includes(category));
  });

  /**
   * The catalogue sends categories UPPERCASE; the chips read as words. The
   * product card's own label stays uppercase, so this converts for the chip
   * only — the raw value is what `selectedCategory` filters on.
   */
  protected categoryLabel(category: string): string {
    return category.charAt(0) + category.slice(1).toLowerCase();
  }

  protected selectCategory(category: string | null): void {
    this.selectedCategory.set(category);
  }
  /** One skeleton per grid slot on a desktop row, so the loading grid fills it. */
  protected readonly skeletons = [0, 1, 2, 3, 4, 5, 6, 7];

  protected readonly products = signal<readonly Product[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  /** The cart drawer's saved-address state reads the signed-in user's address. */
  protected readonly savedAddress = computed(() => this.session.user()?.address ?? null);

  constructor() {
    void this.load();
  }

  /**
   * CONTRACT: Goes through CartStore, never CartApi. Two fast clicks here on a
   * user with no cart yet are exactly the creation race that makes the losing
   * PUT answer 500 (JE-246); the store's queue is what serializes them.
   */
  protected addToCart(productId: string): void {
    void this.cart.add(productId);
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.products.set(await firstValueFrom(this.catalogueApi.listProducts()));
      // A category that no longer exists would filter the grid to nothing.
      if (!this.categories().includes(this.selectedCategory() ?? '')) {
        this.selectedCategory.set(null);
      }
    } catch (error: unknown) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }
}
