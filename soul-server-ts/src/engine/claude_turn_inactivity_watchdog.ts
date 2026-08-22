import type { ClaudeClientEvent } from "./claude_event_mapper.js";

interface ClaudeTurnInactivityWatchdogConfig {
  timeoutMs: number;
  onInactive(uuid: string): Promise<void>;
}

interface ArmedInactivityTimer {
  uuid: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Interrupts a foreground turn only after a full interval without user-visible progress. */
export class ClaudeTurnInactivityWatchdog {
  private armed: ArmedInactivityTimer | null = null;

  constructor(private readonly config: ClaudeTurnInactivityWatchdogConfig) {}

  get timeoutMs(): number {
    return this.config.timeoutMs;
  }

  arm(uuid: string): void {
    this.clear();
    this.armed = { uuid, timer: this.makeTimer(uuid) };
  }

  recordActivity(uuid: string): void {
    if (this.armed?.uuid !== uuid) return;
    clearTimeout(this.armed.timer);
    this.armed.timer = this.makeTimer(uuid);
  }

  recordEvent(uuid: string, event: ClaudeClientEvent): void {
    if (isUserVisibleTurnActivity(event)) this.recordActivity(uuid);
  }

  clear(uuid?: string): void {
    if (!this.armed || (uuid !== undefined && this.armed.uuid !== uuid)) return;
    clearTimeout(this.armed.timer);
    this.armed = null;
  }

  private makeTimer(uuid: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (this.armed?.uuid !== uuid) return;
      this.armed = null;
      void this.config.onInactive(uuid);
    }, this.config.timeoutMs);
    timer.unref?.();
    return timer;
  }
}

function isUserVisibleTurnActivity(event: ClaudeClientEvent): boolean {
  return event.type === "text"
    || event.type === "thinking"
    || event.type === "tool_start"
    || event.type === "tool_result";
}
