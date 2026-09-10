// Reads the events queue's backlog so a run DOOMED to time out says so, instead of
// burning 45s per email-asserting spec on a misleading diagnosis.
//
// CONTRACT: The emails are NOT lost when this warns — they arrive far too late. The
// Lambda drains the shared queue sequentially at ~1 msg/s, so an OTP behind ~800
// load-test events waits ~13 MINUTES while every spec gives up at 45s. Say so in the
// warning: `waitForEmailTo` reports "NOTHING arrived", which reads as a broken
// pipeline and sends the next reader hunting a defect in dispatch, SES or Mailpit.
// WORKAROUND(local): unsigned query-protocol POST, not @aws-sdk/client-sqs — Floci
// answers GetQueueAttributes with no Authorization header, and real AWS rejects it so
// this returns null, degrading to silence rather than a false alarm.
// See [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]]

//: Parsed out of the query protocol's XML rather than with a parser dependency.
// The response shape is a single Attribute/Value pair, so a targeted regex is
// proportionate — and a shape this doesn't match yields null, which the caller
// treats as "could not determine", never as zero.
const DEPTH_PATTERN = /<Name>ApproximateNumberOfMessages<\/Name>\s*<Value>(\d+)<\/Value>/;

// CONTRACT: Return `null` — never zero, never a throw — when the depth cannot be
// determined for any reason. This is advisory only, and a diagnostic that can itself
// fail a run is worse than the problem it reports.
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

// CONTRACT: Do NOT nudge this constant — re-derive it when throughput changes.
// 45s budget - 13s healthy delivery = 32s headroom; at the measured ~0.83 msg/s drain
// that is ~26 messages, rounded DOWN to 25 so the warning fires slightly early.
// See [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]]
export const EVENTS_QUEUE_WARN_DEPTH = 25;
