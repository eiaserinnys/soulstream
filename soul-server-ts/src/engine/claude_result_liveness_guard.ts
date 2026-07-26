export interface ClaudeUncorrelatedResultTimeout {
  activeTurnUuid: string;
  resultUuid: string | null;
}

/**
 * Bounds a Result that cannot be correlated to the active user message.
 *
 * Binding it optimistically can finish the wrong turn. Ignoring it forever
 * leaves the foreground iterator hung. The guard preserves identity first,
 * then emits one explicit recovery signal if no correlated Result arrives.
 */
export class ClaudeResultLivenessGuard {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeTurnUuid: string | null = null;
  private latestResultUuid: string | null = null;

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: (
      event: ClaudeUncorrelatedResultTimeout,
    ) => void | Promise<void>,
  ) {}

  observe(activeTurnUuid: string, resultUuid: string | null): void {
    this.activeTurnUuid = activeTurnUuid;
    this.latestResultUuid = resultUuid;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const active = this.activeTurnUuid;
      if (!active) return;
      this.activeTurnUuid = null;
      const resultUuid = this.latestResultUuid;
      this.latestResultUuid = null;
      void this.onTimeout({ activeTurnUuid: active, resultUuid });
    }, this.timeoutMs);
    this.timer.unref?.();
  }

  settle(turnUuid: string): void {
    if (this.activeTurnUuid !== turnUuid) return;
    this.clear();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.activeTurnUuid = null;
    this.latestResultUuid = null;
  }
}
