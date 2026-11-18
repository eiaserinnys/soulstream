/**
 * In-process wake signal for pending status long polls (design 2.6).
 *
 * Posted replies live in the database; this signal only avoids waiting for the
 * next poll tick. It is not durable and is not shared between processes, which
 * matches the long poll's 25 second upper bound on revocation visibility.
 */

export type ExternalReplySignalListener = () => void;

export class ExternalReplySignal {
  private readonly listeners = new Map<string, Set<ExternalReplySignalListener>>();

  notify(grantId: string, requestId: string): void {
    const listeners = this.listeners.get(signalKey(grantId, requestId));
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A broken listener must not stop the reply write that triggered it.
      }
    }
  }

  subscribe(
    grantId: string,
    requestId: string,
    listener: ExternalReplySignalListener,
  ): () => void {
    const key = signalKey(grantId, requestId);
    let listeners = this.listeners.get(key);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(key);
    };
  }
}

function signalKey(grantId: string, requestId: string): string {
  return `${grantId}:${requestId}`;
}
