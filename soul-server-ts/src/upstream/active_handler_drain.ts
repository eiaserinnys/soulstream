import type { Logger } from "pino";

interface ActiveHandlerMetadata {
  type?: string;
  requestId?: string;
}

interface DrainResult {
  timedOut: boolean;
  handlers: ActiveHandlerMetadata[];
}

export function createActiveHandlerDrain(logger: Logger, timeoutMs: number) {
  const activeHandlers = new Map<Promise<void>, ActiveHandlerMetadata>();

  return {
    handle(raw: Buffer | ArrayBuffer | Buffer[], dispatch: (command: unknown) => Promise<void>): void {
      let command: unknown;
      try {
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf-8")
          : Buffer.isBuffer(raw)
            ? raw.toString("utf-8")
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString("utf-8")
              : String(raw);
        command = JSON.parse(text);
      } catch (err) {
        logger.warn({ err }, "Invalid JSON from upstream");
        return;
      }

      const record = command && typeof command === "object"
        ? command as Record<string, unknown>
        : undefined;
      const metadata: ActiveHandlerMetadata = {
        ...(typeof record?.type === "string" ? { type: record.type } : {}),
        ...(typeof record?.requestId === "string" ? { requestId: record.requestId } : {}),
      };
      const active = dispatch(command);
      activeHandlers.set(active, metadata);
      void active.then(
        () => activeHandlers.delete(active),
        () => activeHandlers.delete(active),
      );
    },

    async drain(): Promise<void> {
      const pending = [...activeHandlers.keys()];
      let timeout: NodeJS.Timeout | undefined;
      const drained = Promise.allSettled(pending).then((): DrainResult => ({
        timedOut: false,
        handlers: [],
      }));
      const expired = new Promise<DrainResult>((resolve) => {
        timeout = setTimeout(() => resolve({
          timedOut: true,
          handlers: [...activeHandlers.values()],
        }), timeoutMs);
      });

      try {
        const result = await Promise.race([drained, expired]);
        if (result.timedOut) {
          logger.warn({
            handlerCount: result.handlers.length,
            handlers: result.handlers,
            timeoutMs,
          }, "Upstream command handlers did not drain before timeout");
        }
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
  };
}
