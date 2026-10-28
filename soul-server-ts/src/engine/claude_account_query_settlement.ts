import type { Logger } from "pino";

import type { ClaudeSdkPersistentSession } from "./claude_sdk_persistent_session.js";
import type { ClaudeRuntimeCloseReason } from "./claude_session_runtime.js";

export class ClaudeAccountQuerySettlement {
  private onClosed: ((reason?: ClaudeRuntimeCloseReason) => Promise<void>) | null = null;
  private pending: Promise<void> | null = null;

  constructor(private readonly waitForChildExit: () => Promise<void>, private readonly logger: Logger) {}

  bind(onClosed: ((reason?: ClaudeRuntimeCloseReason) => Promise<void>) | undefined): void {
    if (onClosed) this.onClosed = onClosed;
  }

  queryClosed(session: ClaudeSdkPersistentSession): void {
    const onClosed = this.onClosed;
    const reason = session.closeReason() ?? undefined;
    this.onClosed = null;
    if (!onClosed) return;
    const pending = session.settled().then(async () => {
      await this.waitForChildExit();
      await onClosed(reason);
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
