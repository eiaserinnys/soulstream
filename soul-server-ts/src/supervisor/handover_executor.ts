import type { SupervisorRegistryRow } from "../db/session_db.js";

export interface SupervisorHandoverExecutorDeps {
  bootReplacement(params: {
    role: string;
    previousSessionId: string;
  }): Promise<{ sessionId: string }>;
  injectSnapshot(params: {
    role: string;
    previousSessionId: string;
    replacementSessionId: string;
    asOfOffset: number;
  }): Promise<void>;
  drainReplacement(params: {
    role: string;
    replacementSessionId: string;
    fromOffset: number;
  }): Promise<{ cursorOffset: number }>;
  activateReplacement(params: {
    role: string;
    activeSessionId: string;
    epoch: number;
    cursorOffset: number;
    handoverState: "idle";
    cumulativeTokens: 0;
    compactionCount: number;
    lastSeenAt: Date | null;
  }): Promise<void>;
  killPrevious(params: {
    role: string;
    previousSessionId: string;
  }): Promise<void>;
}

export class SupervisorHandoverExecutor {
  constructor(private readonly deps: SupervisorHandoverExecutorDeps) {}

  async run(registry: SupervisorRegistryRow): Promise<{
    role: string;
    previousSessionId: string;
    activeSessionId: string;
    epoch: number;
    cursorOffset: number;
  }> {
    if (!registry.activeSessionId) {
      throw new Error(`Supervisor handover requires active session: ${registry.role}`);
    }

    const previousSessionId = registry.activeSessionId;
    const replacement = await this.deps.bootReplacement({
      role: registry.role,
      previousSessionId,
    });
    await this.deps.injectSnapshot({
      role: registry.role,
      previousSessionId,
      replacementSessionId: replacement.sessionId,
      asOfOffset: registry.cursorOffset,
    });
    const drained = await this.deps.drainReplacement({
      role: registry.role,
      replacementSessionId: replacement.sessionId,
      fromOffset: registry.cursorOffset,
    });
    const epoch = registry.epoch + 1;
    await this.deps.activateReplacement({
      role: registry.role,
      activeSessionId: replacement.sessionId,
      epoch,
      cursorOffset: drained.cursorOffset,
      handoverState: "idle",
      cumulativeTokens: 0,
      compactionCount: registry.compactionCount,
      lastSeenAt: registry.lastSeenAt,
    });
    await this.deps.killPrevious({
      role: registry.role,
      previousSessionId,
    });

    return {
      role: registry.role,
      previousSessionId,
      activeSessionId: replacement.sessionId,
      epoch,
      cursorOffset: drained.cursorOffset,
    };
  }
}
