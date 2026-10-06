import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { LucideCircleAlert, LucideRotateCw, LucideX } from '@lucide/angular';

/**
 * Design: `Save Error Banner` (`o6iIDG`); `role="alert"` on the host element.
 * CONTRACT: Do NOT auto-dismiss it — a timed hide leaves a user who looked
 * away with unsaved edits and nothing saying so. It hides only when the host
 * removes it in response to `dismissed` or a successful `retry`.
 */
@Component({
  selector: 'app-save-error-banner',
  imports: [LucideCircleAlert, LucideRotateCw, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './save-error-banner.html',
  host: { class: 'block w-full', role: 'alert' },
})
export class SaveErrorBanner {
  readonly heading = input('Couldn’t save your changes');
  readonly message = input(
    'Something went wrong on our side. Your edits are still here — try again in a moment.',
  );
  readonly retryDisabled = input(false);
  /** Mirrored to the retry button's `aria-busy` while the retried request runs. */
  readonly busy = input(false);
  readonly retryTestId = input<string | null>(null);
  readonly dismissTestId = input<string | null>(null);

  readonly retry = output<void>();
  readonly dismissed = output<void>();
}
