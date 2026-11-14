import type { ControlInboxResult, ControlInboxWork } from "./control_inbox_store.js";

// 내구 작업의 완료 기록(SQLite)이 실패하면(데이터베이스가 바쁨 등) 오류로 올리기 전에 짧게 다시 해 본다.
const COMPLETE_RETRY_DELAYS_MS = [100, 400] as const;

export async function completeDurableWork(input: {
  store: {
    complete(work: ControlInboxWork, response: Record<string, unknown>): ControlInboxResult;
  };
  work: ControlInboxWork;
  response: Record<string, unknown>;
  schedule: (callback: () => void, delayMs: number) => unknown;
  log?: (message: string, fields: Record<string, unknown>) => void;
}): Promise<ControlInboxResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return input.store.complete(input.work, input.response);
    } catch (error) {
      const delayMs = COMPLETE_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) throw error;
      input.log?.("control inbox completion failed; retrying", {
        requestId: input.work.requestId,
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise<void>((resolve) => input.schedule(resolve, delayMs));
    }
  }
}

// lease가 이미 지났는데 다시 집지 못한 경우(데이터베이스가 바쁨 등)에 다시 예약하는 가장 짧은 간격이다.
const MIN_REDISPATCH_DELAY_MS = 1_000;

/**
 * 완료를 적지 못한 내구 작업은 claimed로 남는다. 그런 작업이 남아 있는 동안 연결이 붙어 있으면, 남은 작업의
 * 가장 늦은 lease에 맞춰 스스로 다시 집는다(다음 연결이나 명령을 기다리지 않는다). 다시 집기가 실패하면
 * 기록하고 다시 예약한다. 연결이 끊긴 동안은 예약하지 않고, 다시 붙을 때 예약한다. 다시 집힌 작업의 도메인
 * 효과는 메인 스레드의 활성 작업 중복 막기(control_channel_service)가 되풀이하지 않는다.
 */
export class UncommittedWorkRedispatch {
  private readonly leaseExpiresAt = new Map<string, number>();
  private handle: unknown;

  constructor(private readonly options: {
    schedule: (callback: () => void, delayMs: number) => unknown;
    clearScheduled: (handle: unknown) => void;
    nowEpochMs: () => number;
    isConnected: () => boolean;
    redispatch: () => void;
    log?: (message: string, fields: Record<string, unknown>) => void;
  }) {}

  markFailed(workId: string, leaseExpiresAt: number): void {
    this.leaseExpiresAt.set(workId, leaseExpiresAt);
    this.reschedule();
  }

  /** 다시 집힌 작업은 새 lease를 받는다. */
  refreshLease(workId: string, leaseExpiresAt: number): void {
    if (this.leaseExpiresAt.has(workId)) this.leaseExpiresAt.set(workId, leaseExpiresAt);
  }

  committed(workId: string): void {
    if (this.leaseExpiresAt.delete(workId) && this.leaseExpiresAt.size === 0) this.cancel();
  }

  reschedule(): void {
    this.cancel();
    if (this.leaseExpiresAt.size === 0 || !this.options.isConnected()) return;
    const latest = Math.max(...this.leaseExpiresAt.values());
    const delayMs = Math.max(latest - this.options.nowEpochMs(), MIN_REDISPATCH_DELAY_MS);
    this.handle = this.options.schedule(() => {
      this.handle = undefined;
      this.fire();
    }, delayMs);
  }

  cancel(): void {
    if (this.handle !== undefined) this.options.clearScheduled(this.handle);
    this.handle = undefined;
  }

  private fire(): void {
    if (!this.options.isConnected()) return;
    try {
      this.options.redispatch();
      // 다시 집은 작업은 새 lease를 받았다. lease가 지난 채 남은 것은 이 노드가 쥔 줄이 아니다(이미 완료된
      // 작업에 늦게 온 중복 결과 등). 기다릴 것이 없으니 지워 헛도는 예약을 남기지 않는다.
      const now = this.options.nowEpochMs();
      for (const [workId, leaseExpiresAt] of this.leaseExpiresAt) {
        if (leaseExpiresAt <= now) this.leaseExpiresAt.delete(workId);
      }
    } catch (error) {
      this.options.log?.("control inbox redispatch failed; rescheduling", {
        uncommitted: this.leaseExpiresAt.size,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.reschedule();
  }
}
