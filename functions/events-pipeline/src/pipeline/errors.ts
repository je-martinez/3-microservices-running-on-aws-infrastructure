// Invalid envelope, unknown type, payload that fails validation, missing
// template → persist FAILED and CONSUME the message; retrying can never help.
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

// DocumentDB unreachable, SES down, timeout → goes into batchItemFailures so
// SQS retries it and it eventually lands in the DLQ.
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

// Anything unclassified is treated as transient — the safe default prefers
// retrying over silently losing an event (see the milestone design spec's
// "Error handling" section).
export function isTransient(err: unknown): boolean {
  if (err instanceof PermanentError) return false;
  return true;
}
