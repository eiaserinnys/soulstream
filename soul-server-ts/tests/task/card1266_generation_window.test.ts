/**
 * 카드 #1266 U5b: 세대 넘김 창의 경계 시험이다. 넘김은 실행 시작에서 열리고
 * (`beginGenerationRolloverIfPending`, task_executor.ts), 넘김 상태 영속과 모델 선택 기록
 * (`commitStart`), 넘김 시작 알림(`publishStarted`)을 지나 새 대화가 시작된 뒤 `complete`로
 * 닫힌다. 그 창 안에 멈춤, 지시, 삭제를 운영 진입 함수로 보내 약속 13(지시는 들어가거나
 * 돌아오거나 모름으로 끝난다), 약속 15(멈춤은 멈춤으로 닫히거나 거절로 돌아온다)와
 * 종료 한 번을 본다.
 */
import { describe, expect, it, vi } from "vitest";

import { createExecutionActivation, type Task } from "../../src/task/task_models.js";
import {
  cellAgent,
  deferred,
  fakeRunner,
  flush,
  hydrate,
  makeWorld,
  sessionRow,
  track,
} from "./card1266_request_cells_harness.js";
import {
  deleteTask,
  expectOneTerminal,
  intervene,
  stopTask,
} from "./card1266_request_cells_steps.js";

const REQUESTED_AT = "2026-11-14T02:00:00.000Z";

function catalog() {
  return {
    resolve: vi.fn((id: string) => {
      if (id !== "codex-new" && id !== "codex-old") throw new Error(`unknown preset ${id}`);
      return {
        id,
        label: id,
        backend: "codex" as const,
        model: `${id}-model`,
        env: {},
        supported_efforts: ["high" as const],
      };
    }),
    snapshot: vi.fn(() => ({ presets: [], models: [], persistent_defaults: { fallback_models: [] } })),
  };
}

function contextBuilder() {
  return {
    buildGenerationContext: vi.fn(async () => ({
      effectiveSystemPrompt: "generation system instructions",
      combinedContextItems: [{ key: "persistent_checkpoint", label: "Checkpoint", content: "checkpoint data" }],
      assembledPrompt: "unused",
      checkpointStats: {
        estimatedTokens: 10,
        chars: 20,
        sections: { state: 1, story: 2, summaries: 3, recent: 4 },
        summarizedThroughTurn: 1,
        recentFromEventId: 1,
        recentToEventId: 2,
      },
    })),
    buildFollowupContext: vi.fn(async () => undefined),
    buildAssignedCardContext: vi.fn(async () => ({ key: "assigned_cards", label: "cards", content: "none" })),
    build: vi.fn(async () => undefined),
  };
}

function requestGeneration(task: Task): void {
  // 다른 노드에서 넘어온 퍼시스턴트 세션이다. 이 노드에는 옛 대화가 없어 넘김이 곧 적용된다.
  task.persistent = true;
  task.codexThreadId = undefined;
  task.modelPreset = "codex-old";
  task.metadata ??= [];
  // 이관 흐름은 새 노드에 지시를 보내 넘김을 연다(live_execute_proxy_route_provider.ts).
  task.interventionQueue.push({ text: "넘긴 지시", user: "browser" });
  task.persistentGeneration = {
    number: 1,
    pending: {
      number: 2,
      reason: "context limit",
      requestedAt: REQUESTED_AT,
      targetModelPreset: "codex-new",
      targetReasoningEffort: "high",
    },
  };
}

/**
 * 넘김 창 안에 멈춘 실행이다. 실행 등록은 끝났고 넘김은 열렸다. `model_selection`은 넘김
 * 상태를 영속한 뒤 모델 선택 기록(`commitStart`)에서, `generation_context`는 넘긴 지시를
 * 줄에서 꺼내 새 세대 맥락을 짓는 중(`prepareInitialTurnInput`)에 붙들려 있다.
 */
type WindowPoint = "model_selection" | "generation_context";
const WINDOW_POINTS: readonly WindowPoint[] = ["model_selection", "generation_context"];

async function startInGenerationWindow(point: WindowPoint) {
  const frames = deferred();
  // 넘김 창 안에는 아직 도는 턴이 없어 엔진이 지시를 받지 못한다(codex 어댑터의 no_active_turn).
  const runner = fakeRunner({
    frames: frames.promise,
    engine: {
      intervene: vi.fn(async () => ({
        status: "not_delivered" as const,
        mechanism: "unsupported" as const,
        reason: "no_active_turn" as const,
      })),
    },
  });
  const builder = contextBuilder();
  const world = makeWorld(sessionRow(), { runner, modelCatalog: catalog(), contextBuilder: builder });
  const held = deferred();
  const setModelSelection = world.sessionMutations.setModelSelection as unknown as ReturnType<typeof vi.fn>;
  if (point === "model_selection") {
    setModelSelection.mockImplementationOnce(async () => { await held.promise; });
  } else {
    const build = builder.buildGenerationContext.getMockImplementation()!;
    builder.buildGenerationContext.mockImplementationOnce(async () => {
      await held.promise;
      return await build();
    });
  }
  const task = await hydrate(world);
  requestGeneration(task);
  task.status = "initializing";
  const started = world.executor.startNewExecution(task, cellAgent, createExecutionActivation());
  void Promise.resolve(started).catch(() => undefined);
  await flush();
  expect(task.activeGenerationRollover).toMatchObject({ number: 2, fromBackendSessionId: "cross_node_handoff" });
  expect(task.persistentGeneration?.pending?.applyingFrom).toBe("cross_node_handoff");
  expect(task.status).toBe("running");
  if (point === "model_selection") expect(task.interventionQueue.map((m) => m.text)).toEqual(["넘긴 지시"]);
  else expect(builder.buildGenerationContext).toHaveBeenCalledOnce();
  return {
    world,
    task,
    runner,
    async finish() {
      held.resolve();
      await flush();
      frames.resolve();
      await flush();
    },
  };
}

function generationStartedEvents(world: ReturnType<typeof makeWorld>): number {
  return world.persistenceDouble.enqueueEvent.mock.calls
    .filter((call) => (call[1] as { type?: string }).type === "generation_started").length;
}

function prompts(runner: ReturnType<typeof fakeRunner>): string[] {
  return runner.dispatcher.executeFrames.mock.calls
    .map((call) => String((call[0] as { prompt?: string }).prompt));
}

describe("세대 넘김 창의 경계 시험 (카드 #1266 U5b)", () => {
  it("세대 넘김 창 안에서 멈춤이 오면 첫 턴을 보내지 않고 멈춤 하나로 닫힌다", async () => {
    for (const point of WINDOW_POINTS) {
      const { world, task, runner, finish } = await startInGenerationWindow(point);
      const stopped = track(stopTask(world));
      await finish();

      expect(stopped.value, point).toBe(true);
      expectOneTerminal(world, "killed");
      expect(runner.dispatcher.executeFrames, point).not.toHaveBeenCalled();
      expect(generationStartedEvents(world), point).toBe(0);
      // 넘긴 지시는 버리지 않고 줄에 남는다. 넘김은 적용 중으로 남아 다음 시작이 잇는다.
      expect(task.interventionQueue.map((m) => m.text), point).toEqual(["넘긴 지시"]);
      expect(task.persistentGeneration?.pending?.applyingFrom, point).toBe("cross_node_handoff");
    }
  });

  it("세대 넘김 창 안에서 지시가 오면 대기 줄에 쌓았다가 넘김 뒤 턴에 한 번 넣는다", async () => {
    for (const point of WINDOW_POINTS) {
      const { world, task, runner, finish } = await startInGenerationWindow(point);
      await expect(intervene(world), point).resolves.toMatchObject({ delivered: false, queued: true });
      await finish();

      expectOneTerminal(world, "completed_ok");
      expect(generationStartedEvents(world), point).toBe(1);
      const all = prompts(runner).join("\n");
      expect(all.split("넘긴 지시").length - 1, point).toBe(1);
      expect(all.split("새 지시").length - 1, point).toBe(1);
      expect(task.interventionQueue, point).toEqual([]);
    }
  });

  it("세대 넘김 창 안에서 지우면 첫 턴을 보내지 않고 멈춘 뒤 지운다", async () => {
    for (const point of WINDOW_POINTS) {
      const { world, runner, finish } = await startInGenerationWindow(point);
      const deleted = track(deleteTask(world));
      await finish();

      expect(deleted.value, point).toBe(true);
      expectOneTerminal(world, "killed");
      expect(world.deleteSession, point).toHaveBeenCalledOnce();
      expect(runner.dispatcher.executeFrames, point).not.toHaveBeenCalled();
      expect(generationStartedEvents(world), point).toBe(0);
    }
  });
});
