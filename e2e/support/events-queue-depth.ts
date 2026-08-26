// Reads the events queue's backlog, so a run that is DOOMED to time out says so
// before it burns 45 seconds per email-asserting spec on a misleading diagnosis.
//
// ## The failure this exists to name
//
// Diagnosed 2026-08-25. A Gatling load run leaves several hundred `loadtest-*`
// events on the SHARED queue. The events-pipeline Lambda drains it at roughly
// 1 msg/s (records are processed SEQUENTIALLY — `for (const record of
// event.Records)` in functions/events-pipeline/src/handler.ts, ~376 ms each,
// dominated by the react-email render on a 256 MB function). So an OTP, reset,
// or DELIVERED event published behind ~800 messages waits ~13 MINUTES, while
// every spec that awaits one gives up after 45 s.
//
// The emails are NOT lost — they arrive, far too late. That distinction is the
// entire reason for the warning text: `waitForEmailTo`'s timeout reports
// "NOTHING arrived", which reads as a broken pipeline and sends the next person
// hunting a defect in dispatch, SES, or Mailpit. All three are fine.
//
// ## Why an unsigned POST rather than @aws-sdk/client-sqs
//
// Adding the SDK to this package for one integer is more plumbing than the check
// is worth. Floci's SQS emulator accepts the classic query protocol UNSIGNED
// (verified live: it answered GetQueueAttributes with no Authorization header at
// all), and EVENTS_QUEUE_URL is already in the environment — playwright.config.ts
// loads `.env.local.users` wholesale, and the value is host-reachable
// (`localhost:4566`). So this needs no new dependency and no new env plumbing.
//
// The tradeoff is deliberate: this is a LOCAL-ONLY diagnostic aid. Against real
// AWS the unsigned request would be rejected, and `readEventsQueueDepth` returns
// null — the check degrades to silence rather than to a false alarm.

//: Parsed out of the query protocol's XML rather than with a parser dependency.
// The response shape is a single Attribute/Value pair, so a targeted regex is
// proportionate — and a shape this doesn't match yields null, which the caller
// treats as "could not determine", never as zero.
const DEPTH_PATTERN = /<Name>ApproximateNumberOfMessages<\/Name>\s*<Value>(\d+)<\/Value>/;

// Returns the queue's approximate backlog, or `null` when it cannot be
// determined for ANY reason (no URL configured, endpoint unreachable, an
// unexpected response, a non-local deployment that rejects the unsigned call).
//
// Null rather than a thrown error or a zero: this is an advisory signal, and a
// diagnostic that can itself fail a run would be worse than the problem it
// reports. The caller decides what to do with "unknown", and what it does is
// stay quiet.
export async function readEventsQueueDepth(): Promise<number | null> {
  const queueUrl = process.env.EVENTS_QUEUE_URL;
  if (!queueUrl) return null;

  try {
    const res = await fetch(queueUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        Action: "GetQueueAttributes",
        "AttributeName.1": "ApproximateNumberOfMessages",
        Version: "2012-11-05",
      }).toString(),
      // Short and bounded: global-setup must never hang on this. A slow or
      // absent endpoint is exactly the "unknown" case.
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;

    const match = DEPTH_PATTERN.exec(await res.text());
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

// The backlog above which email assertions are at real risk, derived rather than
// picked round so a future reader can RE-DERIVE it when the throughput changes:
//
//   budget            45 s   (EMAIL_TIMEOUT_MS, every email-asserting spec)
//   healthy delivery  13 s   (measured on a drained queue, 2026-08-25)
//   headroom          32 s
//   drain rate      ~0.83 msg/s  (~50 msg/min, sampled over 18 minutes)
//   → 32 s x 0.83   ≈ 26 messages
//
// 25 is that figure rounded DOWN, so the warning fires slightly before the
// budget is actually exhausted rather than slightly after. If the Lambda's
// per-record cost or its concurrency changes, redo the arithmetic — do not
// nudge the constant.
export const EVENTS_QUEUE_WARN_DEPTH = 25;
