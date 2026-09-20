import type { ActivatedRouteSnapshot } from '@angular/router';

/**
 * CONTRACT: Returns the CONFIGURED route path, never the resolved URL —
 * `/orders/:orderId`, not `/orders/ord_JIfKhAqF5eD9bV7KRnReGpda`. A resolved
 * id makes `page.route` one distinct value per entity, so grouping calls by
 * screen matches a single visit and the page-span list holds one entry per
 * order. Walks `routeConfig.path` down the snapshot tree so every
 * parameterised route is covered, not one hard-coded path.
 * See [[2026-09-19-web-rum-integration-design]]
 */
export function routePatternOf(root: ActivatedRouteSnapshot): string {
  const segments: string[] = [];

  for (
    let node: ActivatedRouteSnapshot | null = root;
    node !== null;
    node = node.firstChild
  ) {
    const path = node.routeConfig?.path;
    if (path) segments.push(path);
  }

  // WHY: Component-less layout parents and the home child both configure an
  // empty path, so a root navigation collects no segments at all.
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}
