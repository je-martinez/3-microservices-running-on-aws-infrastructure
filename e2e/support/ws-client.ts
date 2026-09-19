import WebSocket from "ws";

export interface CollectedSocket {
  messages: unknown[];
  close(): void;
  /**
   * CONTRACT: Pass `matches` whenever the socket carries more than one message type.
   * Several producers publish to the SAME user socket (`TRACKING_STATUS_CHANGED` from
   * the events pipeline, `NOTIFICATION_CREATED` from Users), so an unfiltered wait is
   * satisfied by frames the caller never asked for and the assertion after it then
   * reads a foreign shape — `.map((m) => m.status)` on a notification yields
   * `undefined`. See [[count-only-assertions-hide-cause]]
   */
  waitForCount(
    n: number,
    timeoutMs: number,
    matches?: (message: unknown) => boolean,
  ): Promise<void>;
}

/**
 * Open an authenticated socket and collect everything it receives. The token rides the
 * query string because a WebSocket handshake cannot carry an Authorization header —
 * the only headers reaching the authorizer are the handshake's own.
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
    async waitForCount(n, timeoutMs, matches) {
      const deadline = Date.now() + timeoutMs;
      const matching = () => (matches ? messages.filter(matches) : messages);
      while (matching().length < n) {
        if (Date.now() > deadline) {
          // CONTRACT: Report WHAT arrived, never only how many — and when filtering,
          // report the ignored frames too. "got 3" is identical whether the fan-out
          // dropped a message or the expectation was wrong, and under a filter a bare
          // count cannot distinguish "nothing was published" from "everything published
          // was another type". See [[count-only-assertions-hide-cause]]
          const wanted = matching();
          const ignored = matches ? messages.filter((m) => !matches(m)) : [];
          const rest = matches ? `; ignored ${ignored.length}: ${JSON.stringify(ignored)}` : "";
          throw new Error(
            `timed out waiting for ${n} messages; got ${wanted.length}: ` +
              `${JSON.stringify(wanted)}${rest}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
  };
}

/**
 * Attempt a handshake and resolve with whether it succeeded, distinguishing a real
 * protocol-level "open" from an HTTP 403 Deny or a refused connection. That is what
 * catches a bypassed authorizer: a disabled or broken Deny path resolves `true` for a
 * garbage token and turns the invalid-token test red.
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
