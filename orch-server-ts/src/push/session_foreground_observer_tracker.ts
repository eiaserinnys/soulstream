export class SessionForegroundObserverTracker {
  private readonly counts = new Map<string, number>();

  observe(sessionId: string): () => void {
    this.counts.set(sessionId, this.count(sessionId) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.count(sessionId) - 1;
      if (next <= 0) this.counts.delete(sessionId);
      else this.counts.set(sessionId, next);
    };
  }

  count(sessionId: string): number {
    return this.counts.get(sessionId) ?? 0;
  }

  getStats(): { sessions: number; observers: number } {
    let observers = 0;
    for (const count of this.counts.values()) observers += count;
    return { sessions: this.counts.size, observers };
  }
}
