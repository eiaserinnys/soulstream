export type SerialIntentResult = "executed" | "suppressed";

export interface SerialIntentQueueOptions<TIntent> {
  isReady(): boolean;
  execute(intent: TIntent): Promise<void>;
  shouldSuppress?(pending: TIntent, incoming: TIntent): boolean;
  onPendingCountChange?(pendingCount: number): void;
}

export interface SerialIntentQueue<TIntent> {
  enqueue(intent: TIntent): Promise<SerialIntentResult>;
  notifyReady(): void;
  cancel(reason?: Error): void;
  pendingCount(): number;
}

interface QueuedIntent<TIntent> {
  readonly intent: TIntent;
  readonly resolve: (result: SerialIntentResult) => void;
  readonly reject: (error: unknown) => void;
}

export function createSerialIntentQueue<TIntent>(
  options: SerialIntentQueueOptions<TIntent>,
): SerialIntentQueue<TIntent> {
  const queued: QueuedIntent<TIntent>[] = [];
  let active: QueuedIntent<TIntent> | null = null;
  let waitingForReady: TIntent | null = null;
  let cancelled: Error | null = null;

  const pendingIntents = () => [
    ...(active ? [active.intent] : []),
    ...(waitingForReady === null ? [] : [waitingForReady]),
    ...queued.map((entry) => entry.intent),
  ];
  const pendingCount = () => queued.length + (active ? 1 : 0) + (waitingForReady === null ? 0 : 1);
  const notifyCount = () => options.onPendingCountChange?.(pendingCount());

  const drain = (): void => {
    if (cancelled || active || waitingForReady !== null || queued.length === 0 || !options.isReady()) return;
    active = queued.shift()!;
    notifyCount();
    const current = active;
    void (async () => {
      try {
        await options.execute(current.intent);
        if (!options.isReady()) waitingForReady = current.intent;
        current.resolve("executed");
      } catch (error) {
        current.reject(error);
      } finally {
        if (active === current) active = null;
        notifyCount();
        queueMicrotask(drain);
      }
    })();
  };

  return {
    enqueue(intent) {
      if (cancelled) return Promise.reject(cancelled);
      if (options.shouldSuppress && pendingIntents().some((pending) => options.shouldSuppress!(pending, intent))) {
        return Promise.resolve("suppressed");
      }
      const promise = new Promise<SerialIntentResult>((resolve, reject) => {
        queued.push({ intent, resolve, reject });
      });
      notifyCount();
      drain();
      return promise;
    },
    notifyReady() {
      if (options.isReady()) waitingForReady = null;
      notifyCount();
      drain();
    },
    cancel(reason = new Error("Editor intent queue was cancelled")) {
      cancelled = reason;
      waitingForReady = null;
      while (queued.length > 0) queued.shift()!.reject(reason);
      notifyCount();
    },
    pendingCount() {
      return pendingCount();
    },
  };
}
