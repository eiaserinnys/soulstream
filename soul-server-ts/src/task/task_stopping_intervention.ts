import type { Logger } from "pino";

import type { AutoResumeCallback } from "./task_auto_resume_transition.js";
import type { Task } from "./task_models.js";

/**
 * 멈추는 중인 task의 멈춤 장벽이다. 지시 넘기기 장벽이 아닌 장벽은 멈춤 장벽이다
 * (`Task.interruptBarrierKind`). 멈추는 중이 아니면 없다.
 */
export function stopBarrierOf(task: Task): Promise<boolean> | undefined {
  if (task.interruptRequest === undefined) return undefined;
  if (task.interruptBarrierKind === "intervention_handoff") return undefined;
  return task.interruptRequest;
}

/**
 * 멈추는 중인 실행이 끝나기를 기다린다. 멈춤 마무리는 실행 슬롯을 먼저 비우므로 멈춤 전에
 * 잡은 실행 약속도 함께 기다린다. 그러지 않으면 끝나 가던 턴이 새로 띄운 실행 위에
 * 종료를 한 번 더 올린다. 멈추는 중이 아니면 바로 돌아온다.
 */
export function stopEndOf(task: Task): Promise<void> | undefined {
  const barrier = stopBarrierOf(task);
  if (!barrier) return undefined;
  const execution = task.executionPromise;
  return (async () => {
    await barrier.catch(() => false);
    await execution?.catch(() => undefined);
  })();
}

export interface RestartAfterStopDeps {
  getTask(sessionId: string): Task | undefined;
  /** 같은 세션의 명시적 시작(`ensureRunning`)이 도는 중인가. 그 시작이 쌓인 지시도 함께 꺼낸다. */
  ensuring(sessionId: string): boolean;
  resumeQueuedAfterStop?: (task: Task, onResume: AutoResumeCallback) => Promise<boolean>;
  logger?: Pick<Logger, "warn">;
}

/**
 * 멈추는 중에 쌓은 지시로 멈춤이 끝난 뒤 한 번 다시 띄운다(카드 #1266 U5b, 바깥 요청 칸
 * stopping/intervene). 같은 멈춤에 붙은 두 번째 멈춤이 수렴을 먼저 확인하도록 한 차례
 * 미룬다. 뒤이어 지우는 세션과 명시적 시작이 기다리는 세션은 띄우지 않는다. 쌓인 줄과
 * 끝난 상태의 확인은
 * `resumeQueuedAfterStop`(끝난 뒤 쌓인 지시 다시 띄우기)이 한다.
 */
export async function restartQueuedAfterStop(
  task: Task,
  stopEnd: Promise<void>,
  onResume: AutoResumeCallback,
  deps: RestartAfterStopDeps,
): Promise<void> {
  await stopEnd;
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (task.deletionRequested === true) return;
  if (deps.getTask(task.agentSessionId) !== task) return;
  if (deps.ensuring(task.agentSessionId)) return;
  try {
    await deps.resumeQueuedAfterStop?.(task, onResume);
  } catch (err) {
    deps.logger?.warn(
      { err, sessionId: task.agentSessionId },
      "queued intervention restart after stop failed",
    );
  }
}
