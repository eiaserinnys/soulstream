export class PageAsyncMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(pageId: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(pageId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.tails.set(pageId, queued);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.tails.get(pageId) === queued) this.tails.delete(pageId);
    }
  }

  async runExclusiveMany<T>(pageIds: readonly string[], callback: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(pageIds)].sort();
    const acquire = async (index: number): Promise<T> => (
      index === ordered.length
        ? await callback()
        : await this.runExclusive(ordered[index]!, async () => await acquire(index + 1))
    );
    return await acquire(0);
  }
}
