import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeSessionRuntime } from "./claude_session_runtime.js";
import {
  type ActiveForeground,
  handlePersistentTurnInactivity,
} from "./claude_sdk_persistent_session_support.js";
import { ClaudeRuntimeFollowupWatchdog } from "./claude_runtime_followup_watchdog.js";
import { ClaudeTurnInactivityWatchdog } from "./claude_turn_inactivity_watchdog.js";

export interface ClaudeSdkPersistentTurnTimersConfig {
  runtime: ClaudeSessionRuntime<SDKUserMessage>;
  logger: Logger;
  turnInactivityTimeoutMs: number;
  runtimeFollowupNoOutputTimeoutMs: number;
  postResultDrainMs: number;
  getActive(): ActiveForeground | null;
  setActive(active: ActiveForeground | null): void;
  close(): Promise<void>;
}

export class ClaudeSdkPersistentTurnTimers {
  readonly turnInactivityWatchdog: ClaudeTurnInactivityWatchdog;
  readonly followupWatchdog: ClaudeRuntimeFollowupWatchdog;
  private readonly config: ClaudeSdkPersistentTurnTimersConfig;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ClaudeSdkPersistentTurnTimersConfig) {
    this.config = config;
    this.turnInactivityWatchdog = new ClaudeTurnInactivityWatchdog({
      timeoutMs: config.turnInactivityTimeoutMs,
      onInactive: async (uuid) => await this.handleTurnInactivity(uuid),
    });
    this.followupWatchdog = new ClaudeRuntimeFollowupWatchdog({
      timeoutMs: config.runtimeFollowupNoOutputTimeoutMs,
      logger: config.logger,
    });
  }

  clearForegroundTimers(active: ActiveForeground | null): void {
    if (!active) return;
    this.turnInactivityWatchdog.clear(active.uuid);
    this.followupWatchdog.clear(active.uuid);
    if (active.interruptResultTimer) {
      clearTimeout(active.interruptResultTimer);
      active.interruptResultTimer = null;
    }
  }

  clearDrainTimer(): void {
    if (!this.drainTimer) return;
    clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  armDrainTimer(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      try {
        this.config.runtime.finishDrain();
      } catch (err) {
        this.config.logger.warn({ err }, "Persistent Claude drain phase finalization failed");
      }
    }, this.config.postResultDrainMs);
  }

  private async handleTurnInactivity(uuid: string): Promise<void> {
    await handlePersistentTurnInactivity({
      uuid,
      getActive: this.config.getActive,
      setActive: this.config.setActive,
      runtime: this.config.runtime,
      logger: this.config.logger,
      timeoutMs: this.turnInactivityWatchdog.timeoutMs,
      postResultDrainMs: this.config.postResultDrainMs,
      clearTimers: (active) => this.clearForegroundTimers(active),
      close: this.config.close,
    });
  }
}
