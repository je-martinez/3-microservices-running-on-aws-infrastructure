/**
 * Global setup for the unit suite, registered via the `unit-test` builder's
 * `setupFiles` option in angular.json.
 */

/* WHY: jsdom implements no Web Animations API, so `Element.getAnimations` is
 * absent and any code that enumerates running animations throws instead of
 * seeing an empty list. Real browsers always define it, so this gap belongs to
 * the harness — the polyfill lives here rather than as a guard in
 * `defer-enter-animation.ts`. */
if (typeof Element.prototype.getAnimations !== 'function') {
  Element.prototype.getAnimations = function getAnimations(): Animation[] {
    return [];
  };
}
