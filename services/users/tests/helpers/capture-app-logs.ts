import { symbols } from "pino";
import { appLogger } from "#shared/logging/app-logger";

export type CapturedLine = Record<string, unknown>;

/**
 * Run `fn` with `appLogger`'s destination swapped for an in-memory buffer, and
 * return every record it wrote, already parsed.
 *
 * WHY THE STREAM AND NOT A `vi.spyOn(appLogger, "info")`. A method spy captures
 * the arguments the call site passed and nothing else — but `trace_id`/`span_id`
 * are added by `buildLoggerOptions`' `formatters.log` (shared/logging/logger.ts),
 * which only runs on the way to the stream. Asserting a line falls INSIDE its
 * span is the entire point of these tests, and a spy cannot see that field at
 * all: it would pass identically for a line emitted after the span had ended.
 * Capturing the serialized record exercises the real formatter, so the
 * assertions are made against what OpenObserve would actually receive.
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
