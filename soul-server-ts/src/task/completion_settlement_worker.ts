import type { Logger } from "pino";

import { PeriodicMaintenanceLoop } from "../runtime/periodic_maintenance_loop.js";

const SWEEP_INTERVAL_MS = 5_000;
/** 중앙 읽기와 등록이 한 미결에 몇 번 걸려도 한 주기를 넘기지 않는 상한이다. */
const SWEEP_STEP_TIMEOUT_MS = 90_000;

/**
 * 완료 정산 미결 훑기의 주기 일꾼이다. 완료 전달 장부 일꾼(`CLAUDE_SESSION_RUNTIME_V2`일 때만
 * 만들어진다)과 달리 그 플래그와 무관하게 조립된다: 코덱스 전용 노드와 플래그가 꺼진
 * 노드에도 남은 미결이 있을 수 있다. 시작하면 첫 훑기를 바로 돈다.
 */
export class CompletionSettlementWorker {
  private readonly loop: PeriodicMaintenanceLoop;

  constructor(
    deps: {
      sweepOnce(): Promise<void>;
      logger: Pick<Logger, "info" | "warn" | "error">;
    },
    intervalMs = SWEEP_INTERVAL_MS,
  ) {
    this.loop = new PeriodicMaintenanceLoop({
      lane: "completion-settlement",
      steps: [{ name: "sweep_completion_settlements", run: () => deps.sweepOnce() }],
      intervalMs,
      stepTimeoutMs: SWEEP_STEP_TIMEOUT_MS,
      logger: deps.logger,
    });
  }

  start(): Promise<void> {
    return this.loop.start();
  }

  async stop(timeoutMs = 5_000): Promise<"drained" | "timed_out"> {
    return await this.loop.stop(timeoutMs);
  }

  async runOnce(): Promise<void> {
    await this.loop.runOnce();
  }
}
