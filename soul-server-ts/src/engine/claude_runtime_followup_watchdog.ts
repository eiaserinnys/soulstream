import type { Logger } from "pino";

import type { ClaudeClientEvent } from "./claude_event_mapper.js";

interface FollowupOrigin {
  kind: string;
  id: string;
}

interface WatchdogConfig {
  timeoutMs: number;
  resultWaitMs: number;
  logger: Logger;
  interrupt(uuid: string): Promise<{ still_queued?: string[] }>;
  close(uuid: string, reason: string): Promise<void>;
}

interface ArmedWatchdog {
  uuid: string;
  origin: FollowupOrigin;
  noOutputTimer: ReturnType<typeof setTimeout> | null;
  resultTimer: ReturnType<typeof setTimeout> | null;
  fired: boolean;
}

/** Bounds runtime-followup-only turns without changing the normal turn deadline. */
export class ClaudeRuntimeFollowupWatchdog {
  private armed: ArmedWatchdog | null = null;
  // The SDK may start a task-notification turn before Soulstream arms its follow-up.
  // Keep the observed SDK owner across arm() so later progress stays attributable.
  private observedTurnInputUuid: string | null = null;
  private observedTurnOriginKind: string | null = null;

  constructor(private readonly config: WatchdogConfig) {}

  arm(uuid: string, origin: FollowupOrigin): void {
    this.clear();
    const noOutputTimer = setTimeout(() => {
      void this.handleNoOutput(uuid);
    }, this.config.timeoutMs);
    noOutputTimer.unref?.();
    this.armed = {
      uuid,
      origin,
      noOutputTimer,
      resultTimer: null,
      fired: false,
    };
  }

  observeTurnInput(input: { uuid: string; originKind: string }): void {
    this.observedTurnInputUuid = input.uuid;
    this.observedTurnOriginKind = input.originKind;
  }

  observeTurnResult(result: {
    inputUuid: string | undefined;
    originKind: string | undefined;
  }): void {
    const matchesInput = result.inputUuid === this.observedTurnInputUuid;
    const matchesOrigin = result.originKind === "task-notification"
      && result.originKind === this.observedTurnOriginKind;
    if (!matchesInput && !matchesOrigin) return;
    this.observedTurnInputUuid = null;
    this.observedTurnOriginKind = null;
  }

  observesTurnOrigin(uuid: string, originKind: string): boolean {
    const armed = this.armed;
    return armed?.uuid === uuid && this.observedTurnOriginKind === originKind;
  }

  observesForeignTurn(uuid: string): boolean {
    const armed = this.armed;
    return armed?.uuid === uuid
      && this.observedTurnInputUuid !== null
      && this.observedTurnInputUuid !== uuid;
  }

  observeProgress(uuid: string, event: ClaudeClientEvent): void {
    const armed = this.armed;
    if (!armed || armed.uuid !== uuid || !armed.noOutputTimer) return;
    if (this.observedTurnInputUuid !== uuid) return;
    if (!isForegroundResponseProgress(event)) return;
    clearTimeout(armed.noOutputTimer);
    armed.noOutputTimer = null;
  }

  resultArrived(uuid: string): boolean {
    const fired = this.armed?.uuid === uuid && this.armed.fired;
    this.clear(uuid);
    return fired;
  }

  clear(uuid?: string): void {
    const armed = this.armed;
    if (!armed || (uuid !== undefined && armed.uuid !== uuid)) return;
    if (armed.noOutputTimer) clearTimeout(armed.noOutputTimer);
    if (armed.resultTimer) clearTimeout(armed.resultTimer);
    this.armed = null;
  }

  private async handleNoOutput(uuid: string): Promise<void> {
    const armed = this.armed;
    if (!armed || armed.uuid !== uuid || armed.fired) return;
    armed.fired = true;
    armed.noOutputTimer = null;
    this.config.logger.warn(
      {
        uuid,
        turnOriginKind: armed.origin.kind,
        turnOriginId: armed.origin.id,
        timeoutMs: this.config.timeoutMs,
      },
      "Persistent Claude runtime follow-up produced no foreground progress",
    );
    try {
      const receipt = await this.config.interrupt(uuid);
      if (!this.isCurrent(uuid)) return;
      if (receipt.still_queued?.includes(uuid)) {
        await this.close(uuid, "active_uuid_still_queued");
        return;
      }
      armed.resultTimer = setTimeout(() => {
        void this.close(uuid, "interrupt_result_absent");
      }, this.config.resultWaitMs);
      armed.resultTimer.unref?.();
    } catch (err) {
      if (!this.isCurrent(uuid)) return;
      this.config.logger.warn(
        { err, uuid, turnOriginKind: armed.origin.kind, turnOriginId: armed.origin.id },
        "Persistent Claude runtime follow-up watchdog interrupt failed",
      );
      await this.close(uuid, "interrupt_failed");
    }
  }

  private async close(uuid: string, reason: string): Promise<void> {
    const armed = this.armed;
    if (!armed || armed.uuid !== uuid) return;
    this.config.logger.warn(
      {
        uuid,
        turnOriginKind: armed.origin.kind,
        turnOriginId: armed.origin.id,
        reason,
      },
      "Recreating persistent Claude Query after a runtime follow-up no-op",
    );
    this.clear(uuid);
    await this.config.close(uuid, reason);
  }

  private isCurrent(uuid: string): boolean {
    return this.armed?.uuid === uuid;
  }
}

function isForegroundResponseProgress(event: ClaudeClientEvent): boolean {
  return event.type === "text"
    || event.type === "thinking"
    || event.type === "tool_start"
    || event.type === "tool_result";
}
