/**
 * Tears down the inline boot loader in `index.html` once Angular has rendered.
 *
 * The loader paints brand navy with a pulsing mark so the browser never shows a
 * white frame while the bundle downloads and bootstraps.
 */

const LOADER_ID = 'boot-loader';

/** Matches the `transition: opacity 200ms` on `#boot-loader` in index.html. */
const FADE_MS = 200;

/**
 * CONTRACT: Call this only AFTER Angular's first render has committed to the DOM
 * (`afterNextRender`) — removing the loader any earlier uncovers an empty
 * `<app-root>` and reintroduces the white flash it exists to hide.
 */
export function dismissBootLoader(): void {
  const el = document.getElementById(LOADER_ID);
  if (!el) return;

  el.classList.add('boot-loader-done');
  // `transitionend` is skipped when the tab is hidden, which would strand the
  // loader over the app; a timer always fires.
  setTimeout(() => el.remove(), FADE_MS);
}
