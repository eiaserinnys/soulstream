import type { Logger } from "pino";

import type { ClaudeSdkPersistentSession } from "./claude_sdk_persistent_session.js";

export class ClaudeAccountQuerySettlement {
  private onClosed: (() => Promise<void>) | null = null;
  private pending: Promise<void> | null = null;

  constructor(private readonly waitForChildExit: () => Promise<void>, private readonly logger: Logger) {}

  bind(onClosed: (() => Promise<void>) | undefined): void {
    if (onClosed) this.onClosed = onClosed;
  }

  queryClosed(session: ClaudeSdkPersistentSession): void {
    const onClosed = this.onClosed;
    this.onClosed = null;
    if (!onClosed) return;
    const pending = session.settled().then(async () => {
      await this.waitForChildExit();
      await onClosed();
    });
    this.pending = pending;
    void pending.catch((err) => this.logger.error({ err }, "Claude account Query settlement failed"));
  }

  async settle(): Promise<void> {
    while (this.pending) {
      const pending = this.pending;
      await pending;
      if (this.pending === pending) this.pending = null;
    }
    const onClosed = this.onClosed;
    this.onClosed = null;
    await onClosed?.();
  }
}
