import { symbols } from "pino";
import { appLogger } from "#shared/logging/app-logger";

export type CapturedLine = Record<string, unknown>;

/**
 * Run `fn` with `appLogger`'s destination swapped for an in-memory buffer, and
 * return every record it wrote, already parsed.
 *
 * CONTRACT: Capture the STREAM, not a `vi.spyOn(appLogger, "info")`. A method spy
 * sees only the call site's arguments, while `trace_id`/`span_id` are added by
 * `formatters.log` on the way to the stream — so a spy passes identically for a line
 * emitted after its span ended, which is exactly what these tests exist to catch.
 * See [[logging-context]]
 */
export async function captureAppLogs(fn: () => Promise<void>): Promise<CapturedLine[]> {
  const lines: string[] = [];
  const logger = appLogger as unknown as Record<symbol, unknown>;
  const original = logger[symbols.streamSym];
  logger[symbols.streamSym] = { write: (s: string) => lines.push(s) };
  try {
    await fn();
  } finally {
    logger[symbols.streamSym] = original;
  }
  return lines.map((line) => JSON.parse(line) as CapturedLine);
}

/** The single captured line carrying `app_event`, or undefined. */
export function lineFor(lines: CapturedLine[], appEvent: string): CapturedLine | undefined {
  return lines.find((l) => l.app_event === appEvent);
}
