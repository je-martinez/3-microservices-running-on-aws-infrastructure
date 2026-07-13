export interface EventPublisher {
  publishUserCreated(payload: { id: string; email: string }): Promise<void>;
}

// No-op for this milestone: the emission point exists; SQS wiring is deferred.
export class NoopEventPublisher implements EventPublisher {
  async publishUserCreated(_payload: { id: string; email: string }): Promise<void> {
    return;
  }
}
