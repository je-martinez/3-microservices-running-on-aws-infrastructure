import { Component, computed, inject, signal } from '@angular/core';
import { LucideChevronDown, LucideRefreshCw, LucideTriangleAlert } from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import { CatalogueApi } from '../../core/api/catalogue-api';
import type { Product } from '../../core/api/types';
import { SessionStore } from '../../core/auth/session-store';
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

  protected readonly overlay = inject(OverlayStore);
  protected readonly categories = ['Footwear', 'Bags', 'Accessories'];
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

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.products.set(await firstValueFrom(this.catalogueApi.listProducts()));
    } catch (error: unknown) {
      this.error.set(authErrorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }
}
