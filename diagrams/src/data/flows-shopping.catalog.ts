import type { CatalogEntry } from "../catalog";
import { checkoutAddressGeocodingProxy } from "./flows/checkout-address-geocoding-proxy";
import { ordersCatalogueCart } from "./flows/orders-catalogue-cart";
import { responseCache } from "./flows/response-cache";

export const shoppingFlowEntries: CatalogEntry[] = [
  {
    id: "orders-catalogue-cart",
    title: ordersCatalogueCart.title,
    primitive: "flow",
    output: "docs/domains/orders/specs/diagrams/orders-catalogue-cart",
    watches: [
      "services/orders/src/Orders.Api/Endpoints/CartEndpoints.cs",
      "services/orders/src/Orders.Api/Endpoints/ProductEndpoints.cs",
      "services/orders/src/Orders.Infrastructure/Carts/**",
      "services/orders/src/Orders.Infrastructure/Caching/**",
      "apps/web/src/app/features/cart/**",
      "apps/web/src/app/features/catalogue/**",
      "apps/web/src/app/core/cart/**",
    ],
    data: ordersCatalogueCart,
  },
  {
    id: "response-cache",
    title: responseCache.title,
    primitive: "flow",
    output: "docs/shared/patterns/diagrams/response-cache",
    watches: [
      "services/*/src/shared/cache/**",
      "services/orders/src/Orders.Infrastructure/Caching/**",
      "infra/modules/redis/**",
    ],
    data: responseCache,
  },
  {
    id: "checkout-address-geocoding-proxy",
    title: checkoutAddressGeocodingProxy.title,
    primitive: "flow",
    output: "docs/domains/orders/specs/diagrams/checkout-address-geocoding-proxy",
    watches: [
      "apps/web/nginx.conf",
      "apps/web/src/app/core/api/geocode-api.ts",
      "apps/web/src/app/shared/ui/street-autocomplete.ts",
      "apps/web/src/app/features/checkout/checkout-payment.ts",
    ],
    data: checkoutAddressGeocodingProxy,
  },
];
