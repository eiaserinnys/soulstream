import type { SupervisorWakeEvent } from "./wake_router.js";

export type SupervisorWakeDispatchState = "active" | "retrying" | "blocked";

export interface SupervisorWakeDispatchSnapshot {
  state: SupervisorWakeDispatchState;
  lastSignature: string | null;
  repeatCount: number;
}

export interface SupervisorWakeDispatchUpdate extends SupervisorWakeDispatchSnapshot {
  supervisorId: string;
  blockedReason?: string | null;
  blockedAt?: Date | null;
}

export interface SupervisorWakeCircuitBreakerDeps {
  getWakeDispatchState?(supervisorId: string): Promise<SupervisorWakeDispatchSnapshot | null>;
  setWakeDispatchState?(state: SupervisorWakeDispatchUpdate): Promise<void>;
  logger?: {
    warn?(payload: unknown, message: string): void;
    error?(payload: unknown, message: string): void;
  };
  now?: () => Date;
}

const DEFAULT_STATE: SupervisorWakeDispatchSnapshot = {
  state: "active",
  lastSignature: null,
  repeatCount: 0,
};

export class SupervisorWakeCircuitBreaker {
  constructor(
    private readonly deps: SupervisorWakeCircuitBreakerDeps,
    private readonly threshold: number,
  ) {}

  async isBlocked(supervisorId: string): Promise<boolean> {
    const state = await this.readState(supervisorId);
    return state.state === "blocked";
  }

  async recordForwardProgress(supervisorId: string): Promise<void> {
    const current = await this.readState(supervisorId);
    if (
      current.state === "active" &&
      current.lastSignature === null &&
      current.repeatCount === 0
    ) {
      return;
    }
    await this.writeState({
      supervisorId,
      state: "active",
      lastSignature: null,
      repeatCount: 0,
      blockedReason: null,
      blockedAt: null,
    }, "Supervisor wake circuit breaker progress reset failed");
  }

  async blockIfRepeatedNoProgress(params: {
    supervisorId: string;
    signature: string;
    reason: string;
  }): Promise<boolean> {
    const current = await this.readState(params.supervisorId);
    if (current.state !== "active" || current.lastSignature !== params.signature) {
      return false;
    }

    const repeatCount = current.repeatCount + 1;
    if (repeatCount < this.threshold) {
      await this.writeState({
        supervisorId: params.supervisorId,
        state: "active",
        lastSignature: params.signature,
        repeatCount,
        blockedReason: null,
        blockedAt: null,
      }, "Supervisor wake circuit breaker repeated no-progress record failed");
      return false;
    }

    await this.block(params, repeatCount);
    return true;
  }

  async recordNoForwardProgress(params: {
    supervisorId: string;
    signature: string;
    reason: string;
  }): Promise<void> {
    const current = await this.readState(params.supervisorId);
    if (current.state === "retrying") {
      await this.block(params, 1);
      return;
    }

    await this.writeState({
      supervisorId: params.supervisorId,
      state: "active",
      lastSignature: params.signature,
      repeatCount: current.lastSignature === params.signature
        ? current.repeatCount + 1
        : 0,
      blockedReason: null,
      blockedAt: null,
    }, "Supervisor wake circuit breaker no-progress record failed");
  }

  private async block(
    params: {
      supervisorId: string;
      signature: string;
      reason: string;
    },
    repeatCount: number,
  ): Promise<void> {
    const blockedAt = this.deps.now?.() ?? new Date();

    await this.writeState({
      supervisorId: params.supervisorId,
      state: "blocked",
      lastSignature: params.signature,
      repeatCount,
      blockedReason: params.reason,
      blockedAt,
    }, "Supervisor wake circuit breaker block record failed");

    this.deps.logger?.error?.(
      {
        supervisorId: params.supervisorId,
        signature: params.signature,
        repeatCount,
        threshold: this.threshold,
        reason: params.reason,
        blockedAt,
      },
      "Supervisor wake dispatch blocked after repeated no-progress flush",
    );
  }

  private async readState(supervisorId: string): Promise<SupervisorWakeDispatchSnapshot> {
    if (!this.deps.getWakeDispatchState) return DEFAULT_STATE;
    try {
      return normalizeWakeDispatchSnapshot(
        await this.deps.getWakeDispatchState(supervisorId),
      );
    } catch (err) {
      this.deps.logger?.warn?.(
        { err, supervisorId },
        "Supervisor wake circuit breaker state read failed",
      );
      return DEFAULT_STATE;
    }
  }

  private async writeState(
    state: SupervisorWakeDispatchUpdate,
    warningMessage: string,
  ): Promise<void> {
    if (!this.deps.setWakeDispatchState) return;
    try {
      await this.deps.setWakeDispatchState(state);
    } catch (err) {
      if (this.deps.logger?.error) {
        this.deps.logger.error(
          { err, supervisorId: state.supervisorId, nextState: state.state },
          warningMessage,
        );
      } else {
        this.deps.logger?.warn?.(
          { err, supervisorId: state.supervisorId, nextState: state.state },
          warningMessage,
        );
      }
    }
  }
}

export function buildEventWakeDispatchSignature(params: {
  cursor: number;
  head: number;
  events: SupervisorWakeEvent[];
}): string {
  const sourceSessionIds = Array.from(new Set(
    params.events.map((event) => event.sourceSessionId ?? "(none)"),
  )).sort();
  const eventTypes = Array.from(new Set(
    params.events.map((event) => event.eventType),
  )).sort();
  return [
    "events",
    `${params.cursor}->${params.head}`,
    `count=${params.events.length}`,
    `sources=${sourceSessionIds.join(",")}`,
    `types=${eventTypes.join(",")}`,
  ].join("|");
}

export function buildSnapshotWakeDispatchSignature(params: {
  cursor: number;
  head: number;
}): string {
  return ["snapshot", `${params.cursor}->${params.head}`].join("|");
}

function normalizeWakeDispatchSnapshot(
  state: SupervisorWakeDispatchSnapshot | null,
): SupervisorWakeDispatchSnapshot {
  if (!state) return DEFAULT_STATE;
  return {
    state: normalizeWakeDispatchState(state.state),
    lastSignature: state.lastSignature ?? null,
    repeatCount: Number.isFinite(state.repeatCount) ? Math.max(0, state.repeatCount) : 0,
  };
}

function normalizeWakeDispatchState(value: string): SupervisorWakeDispatchState {
  if (value === "retrying" || value === "blocked") return value;
  return "active";
}
