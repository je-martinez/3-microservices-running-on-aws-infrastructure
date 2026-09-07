/**
 * CONTRACT: `complete` asserts the buyer already supplied that step's
 * information. Do NOT mark a step complete while the page below still asks for
 * it — a stepper hardcoded to "Cart ✓ Address ✓" claimed a saved address while
 * the form under it was collecting one.
 */
export type CheckoutStepState = 'complete' | 'current' | 'upcoming';

export interface CheckoutStep {
  label: string;
  state: CheckoutStepState;
  /** Lucide icon rendered inside the marker; the check is implied by `complete`. */
  icon: 'check' | 'map-pin' | 'credit-card';
}
