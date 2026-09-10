/**
 * Formats a locally-computed cents figure for display.
 *
 * CONTRACT: Use this ONLY for arithmetic the server does not do — a quantity
 * preview in the cart. Any amount the server already sent as `Money` renders
 * its `formatted` string verbatim instead: the server rounds tax per line, so a
 * client that re-derives a total from `cents` shows a figure a cent away from
 * what checkout actually charges. Reaching for this function to display an
 * `order.total` or a `product.unitPrice` is the mistake it is narrow to prevent.
 * See [[money-representation]]
 */
export function formatCentsAsUsd(cents: number): string {
  // Mirrors the server's own "C2" en-US formatting, thousands separator
  // included, so a preview and a server-sent amount read identically.
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}
