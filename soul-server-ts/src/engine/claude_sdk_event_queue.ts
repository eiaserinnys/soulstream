export type EventQueue<T> = AsyncIterableIterator<T> & {
  push(value: T): boolean;
  close(): void;
  fail(err: unknown): void;
};

export function createEventQueue<T>(): EventQueue<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (err: unknown) => void;
  }> = [];
  let closed = false;
  let failure: unknown;

  const iterator: EventQueue<T> = {
    push(value) {
      if (closed || failure !== undefined) return false;
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ done: false, value });
        return true;
      }
      values.push(value);
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter.resolve({ done: true, value: undefined as T });
      }
    },
    fail(err) {
      if (failure !== undefined) return;
      failure = err;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(err);
      }
    },
    async next() {
      if (failure !== undefined) throw failure;
      const value = values.shift();
      if (value !== undefined) return { done: false, value };
      if (closed) return { done: true, value: undefined as T };
      return new Promise<IteratorResult<T>>((resolve, reject) =>
        waiters.push({ resolve, reject }),
      );
    },
    async return() {
      iterator.close();
      return { done: true, value: undefined as T };
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}
