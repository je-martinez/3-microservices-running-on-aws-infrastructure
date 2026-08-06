import WebSocket from "ws";

export interface CollectedSocket {
  messages: unknown[];
  close(): void;
  waitForCount(n: number, timeoutMs: number): Promise<void>;
}

/**
 * Open an authenticated socket and collect everything it receives.
 *
 * The token goes in the query string because a WebSocket handshake cannot
 * carry an Authorization header — confirmed against the real authorizer
 * (functions/realtime-events/src/authorizer.ts): the only headers that reach
 * it are the handshake's own (Sec-WebSocket-Key, Connection, etc.), never
 * Authorization.
 */
export async function openSocket(wsUrl: string, token: string): Promise<CollectedSocket> {
  const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
  const messages: unknown[] = [];

  socket.on("message", (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()));
    } catch {
      messages.push(raw.toString());
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  return {
    messages,
    close: () => socket.close(),
    async waitForCount(n, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (messages.length < n) {
        if (Date.now() > deadline) {
          // Report WHAT arrived, not just how many. "got 3" is the same
          // message whether the fan-out is broken or the clock is short, and
          // that ambiguity cost real debugging time — the statuses tell you
          // immediately which transition went missing.
          const detail = JSON.stringify(messages);
          throw new Error(
            `timed out waiting for ${n} messages; got ${messages.length}: ${detail}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
  };
}

/**
 * Attempt a handshake and resolve with whether it succeeded.
 *
 * Distinguishes an actual protocol-level "open" event from anything else
 * (HTTP 403 from the authorizer's Deny policy, connection refused, etc.),
 * which is what makes this able to catch a bypassed authorizer: if the
 * authorizer were disabled or the Deny path were broken, this would resolve
 * `true` for a garbage token and the invalid-token test would go red.
 */
export async function tryOpen(wsUrl: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
    socket.once("open", () => {
      socket.close();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("unexpected-response", (_req, res) => {
      // The `ws` library emits this instead of "error" when the server
      // responds to the HTTP upgrade with a non-101 status (e.g. the
      // authorizer's 403 Deny) — surface it as a failed handshake too.
      res.resume();
      resolve(false);
    });
  });
}
