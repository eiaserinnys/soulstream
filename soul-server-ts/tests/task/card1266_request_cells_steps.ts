/**
 * 카드 #1266 U5b 바깥 요청 칸 경계 시험의 공유 단계다. 운영 진입 함수를 부르는 요청과
 * 시동 중, 보유, 해제 상태를 운영 코드로 만드는 단계를 둔다.
 */
import { expect, vi } from "vitest";

import { decideNodeRequest } from "../../src/task/state/node_request_decision.js";
import type { NodeExecutionPhase } from "../../src/task/state/node_execution_machine.js";
import type {
  NodeRequestDisposition,
  NodeRequestKind,
} from "../../src/task/state/node_request_machine.js";

import {
  deferred,
  fakeRunner,
  flush,
  hydrate,
  makeWorld,
  phaseOf,
  runnerRegistration,
  SESSION_ID,
  sessionRow,
  startRunning,
  type CellWorld,
} from "./card1266_request_cells_harness.js";

/** 정의의 판정이 운영에서 본 처분과 같은지 본다. */
export function expectDefinition(
  phase: NodeExecutionPhase,
  request: NodeRequestKind,
  disposition: NodeRequestDisposition,
): void {
  expect(decideNodeRequest(phase, request)).toBe(disposition);
}

export const stopTask = (world: CellWorld) => world.manager.cancelTask(SESSION_ID);
export const deleteTask = (world: CellWorld) => world.manager.deleteTask(SESSION_ID);
export const intervene = (world: CellWorld, text = "새 지시") =>
  world.manager.addIntervention(world.message(text), world.onResume);
export const resume = (world: CellWorld) =>
  world.manager.ensureRunning(world.message("시작", { deliveryId: "delivery-start" }), world.onResume);

/** 끝난 세션을 다시 띄우되 활성화를 붙들어 시동 중에 멈춰 둔다. */
export async function startStarting(world: CellWorld) {
  const task = await hydrate(world);
  let release!: () => void;
  const first = world.manager.addIntervention(world.message("첫 지시"), (started, activation) => {
    release = () => {
      started.status = "running";
      started.executionRegistration = {
        registrationId: "registration-start",
        executionCommandId: "command-start",
      };
      if (started.executionActivation === activation) started.executionActivation = undefined;
      activation?.resolve();
    };
  });
  void first.catch(() => undefined);
  await flush();
  return { task, release: () => release(), first };
}

/** 실제 턴이 끝나 종료 정리가 러너를 보유한 상태다. */
export async function startRetained(kind: "claude_background" | "codex_command") {
  const frames = deferred();
  const runner = fakeRunner({
    frames: frames.promise,
    engine: kind === "claude_background"
      ? {
          detachedClaudeRuntime: true,
          detachedClaudeRuntimeActivity: vi.fn(async () => ({
            foregroundPhase: "idle",
            queryLifecycle: "idle",
            backgroundTaskCount: 1,
            pendingInputRequestCount: 0,
          })),
        }
      : {
          codexDetachedCommandRuntime: true,
          codexDetachedCommandActivity: vi.fn(async () => ({
            activeForegroundCount: 0,
            detachedRunningCount: 1,
            retainedTerminalResultCount: 0,
            earliestRetainedTerminalDeadlineAtMs: null,
          })),
        },
  });
  const world = makeWorld(sessionRow(), { runner });
  const task = await startRunning(world);
  frames.resolve();
  await flush();
  expect(phaseOf(task, { retentionKind: kind })).toBe(`retained_${kind}`);
  return { world, task, runner };
}

/** 보유가 만료돼 종료 정리가 러너 해제를 청구한 상태다. 러너 닫기는 붙들려 있다. */
export async function startReleasing() {
  const { world, task, runner } = await startRetained("codex_command");
  const activity = (runner.engine as unknown as {
    codexDetachedCommandActivity: ReturnType<typeof vi.fn>;
  }).codexDetachedCommandActivity;
  activity.mockResolvedValue({
    activeForegroundCount: 0,
    detachedRunningCount: 0,
    retainedTerminalResultCount: 0,
    earliestRetainedTerminalDeadlineAtMs: null,
  });
  const closing = deferred();
  runner.close.mockImplementationOnce(async () => { await closing.promise; });
  const registration = runnerRegistration();
  const release = world.executor.releaseExpiredRetainedRunner(task, registration, true);
  await flush();
  expect(phaseOf(task)).toBe("retained_releasing");
  return {
    world,
    task,
    runner,
    async finishRelease() {
      closing.resolve();
      await expect(release).resolves.toBe("released");
      expect(world.executor.completeRetainedRunnerReleaseAfterTermination(task, registration))
        .toBe(true);
      await flush();
    },
  };
}

export function expectOneTerminal(world: CellWorld, reason: string): void {
  expect(world.terminalReasons()).toEqual([reason]);
}
