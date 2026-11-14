/**
 * 카드 #1266 U5b 바깥 요청 칸의 경계 시험이다(종료 뒤 보유와 해제, 잇기 대기, 주인 없음과
 * 쌓인 지시의 순서).
 * 칸마다 그 실행 상태를 운영 코드로 만든 뒤 TaskManager의 운영 진입 함수로 요청을 보내 나온
 * 처분을 보고, 정의의 판정 함수가 같은 처분을 내는지도 본다. 시험 이름은 `NODE_REQUEST_TABLE`의
 * `test`와 같아야 하고 `tests/task/state/node_barrier_request.test.ts`가 그 대응을 확인한다.
 */
import { describe, expect, it, vi } from "vitest";

import { RunnerRecoveryCoordinator } from "../../src/runner/runner_recovery_coordinator.js";
import { startWorkerRuntime } from "../../src/runtime/worker_startup.js";
import { createExecutionActivation, type Task } from "../../src/task/task_models.js";

import {
  cellAgent,
  deferred,
  fakeRunner,
  flush,
  hydrate,
  makeWorld,
  phaseOf,
  registeredRow,
  runnerRegistration,
  silentLogger,
  startAdopting,
  terminalRow,
  track,
  type CellWorld,
  type FakeRunner,
} from "./card1266_request_cells_harness.js";
import {
  deleteTask,
  expectDefinition,
  expectOneTerminal,
  intervene,
  resume,
  startReleasing,
  startRetained,
  startStarting,
  stopTask,
} from "./card1266_request_cells_steps.js";

describe("바깥 요청 칸의 경계 시험 (카드 #1266 U5b)", () => {
  type RetainedKind = "claude_background" | "codex_command";

  async function retainedStop(kind: RetainedKind) {
    const { world, task, runner } = await startRetained(kind);
    expectDefinition(`retained_${kind}`, "stop", "reject_not_running");

    await expect(stopTask(world)).resolves.toBe(false);
    expect(task.runner).toBe(runner.runner);
    expect(runner.close).not.toHaveBeenCalled();
    expect(runner.interrupt).not.toHaveBeenCalled();
  }

  async function retainedIntervene(kind: RetainedKind) {
    const { world, runner } = await startRetained(kind);
    expectDefinition(`retained_${kind}`, "intervene", "queue_and_restart");

    await expect(intervene(world)).resolves.toEqual({ autoResumed: true });
    expect(world.resumes).toHaveLength(1);
    expect(world.resumes[0]!.runnerAtStart).toBe(runner.runner);
    expect(world.resumes[0]!.queueAtStart).toEqual(["새 지시"]);
    expect(runner.close).not.toHaveBeenCalled();
  }

  async function retainedDelete(kind: RetainedKind) {
    const { world, runner } = await startRetained(kind);
    expectDefinition(`retained_${kind}`, "delete", "delete_row");
    const terminalsBefore = world.terminalReasons();

    await expect(deleteTask(world)).resolves.toBe(true);
    expect(runner.close).toHaveBeenCalled();
    expect(runner.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(world.deleteSession).toHaveBeenCalledOnce();
    expect(world.terminalReasons()).toEqual(terminalsBefore);
  }

  async function retainedResume(kind: RetainedKind) {
    const { world, runner } = await startRetained(kind);
    expectDefinition(`retained_${kind}`, "resume", "start_on_retained_runner");

    await expect(resume(world)).resolves.toMatchObject({ state: "started" });
    expect(world.resumes).toHaveLength(1);
    expect(world.resumes[0]!.runnerAtStart).toBe(runner.runner);
  }

  describe("클로드 보유", () => {
    it("클로드 보유 중에 멈춤이 오면 거짓을 돌려준다", async () => {
      await retainedStop("claude_background");
    });
    it("클로드 보유 중에 지시가 오면 보유한 러너로 다시 띄운다", async () => {
      await retainedIntervene("claude_background");
    });
    it("클로드 보유 중에 지우면 보유한 러너를 닫고 줄을 지운다", async () => {
      await retainedDelete("claude_background");
    });
    it("클로드 보유 중에 재개가 오면 보유한 러너로 새 실행을 시작한다", async () => {
      await retainedResume("claude_background");
    });
  });

  describe("코덱스 보유", () => {
    it("코덱스 보유 중에 멈춤이 오면 거짓을 돌려준다", async () => {
      await retainedStop("codex_command");
    });
    it("코덱스 보유 중에 지시가 오면 보유한 러너로 다시 띄운다", async () => {
      await retainedIntervene("codex_command");
    });
    it("코덱스 보유 중에 지우면 보유한 러너를 닫고 줄을 지운다", async () => {
      await retainedDelete("codex_command");
    });
    it("코덱스 보유 중에 재개가 오면 보유한 러너로 새 실행을 시작한다", async () => {
      await retainedResume("codex_command");
    });
  });

  describe("러너 해제 중", () => {
    it("러너 해제 중에 멈춤이 오면 거짓을 돌려준다", async () => {
      const { world, finishRelease } = await startReleasing();
      expectDefinition("retained_releasing", "stop", "reject_not_running");

      await expect(stopTask(world)).resolves.toBe(false);
      await finishRelease();
    });

    it("러너 해제 중에 지시가 오면 해제가 끝난 뒤 다시 띄운다", async () => {
      const { world, finishRelease } = await startReleasing();
      expectDefinition("retained_releasing", "intervene", "queue_and_restart");

      const resumed = track(intervene(world));
      await flush();
      expect(resumed.settled).toBe(false);
      await finishRelease();
      expect(resumed.value).toEqual({ autoResumed: true });
      expect(world.resumes).toHaveLength(1);
      expect(world.resumes[0]!.runnerAtStart).toBeUndefined();
    });

    it("러너 해제 중에 지우면 러너를 닫고 줄을 지운다", async () => {
      const { world, runner, finishRelease } = await startReleasing();
      expectDefinition("retained_releasing", "delete", "delete_row");

      const deleted = track(deleteTask(world));
      await flush();
      await finishRelease();
      expect(deleted.value).toBe(true);
      expect(runner.retireTerminalRegistration).toHaveBeenCalledOnce();
      expect(world.deleteSession).toHaveBeenCalledOnce();
    });

    it("러너 해제 중에 재개가 오면 해제가 끝난 뒤 시작한다", async () => {
      const { world, finishRelease } = await startReleasing();
      expectDefinition("retained_releasing", "resume", "wait_then_start");

      const started = track(resume(world));
      await flush();
      expect(started.settled).toBe(false);
      await finishRelease();
      expect(started.value).toMatchObject({ state: "started" });
      expect(world.resumes[0]!.runnerAtStart).toBeUndefined();
    });
  });

  describe("살아 있는 러너를 잇겠다고 알리고 응답을 기다리는 중 (옛 짐작 6, 7, 17, 18)", () => {
    it("잇기 응답을 기다리는 중에 지시가 오면 이은 러너의 엔진에 넘긴다", async () => {
      const frames = deferred();
      const runner = fakeRunner({ frames: frames.promise });
      const world = makeWorld(registeredRow(), { runner });
      const { task, answer, recovery } = await startAdopting(world);
      // 잇기는 중앙 줄의 실행 등록을 가진 채 기다리므로 running으로 투영된다.
      expect(phaseOf(task)).toBe("running");
      expectDefinition("running", "intervene", "deliver_or_queue");

      await expect(intervene(world)).resolves.toEqual({ delivered: true });
      expect(runner.engine.intervene).toHaveBeenCalledOnce();
      answer.resolve();
      frames.resolve();
      await recovery;
      expect(task.interventionQueue).toEqual([]);
    });

    it("잇기 응답을 기다리는 중에 멈춤이 오면 멈춤 하나로 닫힌다", async () => {
      const frames = deferred();
      const runner = fakeRunner({ frames: frames.promise });
      const world = makeWorld(registeredRow(), { runner });
      const { task, answer, recovery } = await startAdopting(world);
      expect(phaseOf(task)).toBe("running");
      expectDefinition("running", "stop", "interrupt_and_terminate");
      // 잇기를 먼저 보냈으므로 잇기 응답이 종료 응답보다 먼저 닿는다.
      const terminal = world.holdNextTerminalAnswer();

      const stopped = track(stopTask(world));
      await flush();
      answer.resolve();
      await flush();
      terminal.resolve();
      await flush();
      frames.resolve();
      await recovery.catch(() => undefined);
      await flush();

      expect(stopped.value).toBe(true);
      expect(runner.interrupt).toHaveBeenCalledOnce();
      expectOneTerminal(world, "killed");
      expect(task.status).toBe("interrupted");
    });
  });

  describe("주인 없음과 쌓인 지시의 순서 (옛 짐작 19, 20)", () => {
    function coordinatorFor(
      world: CellWorld,
      registration: ReturnType<typeof runnerRegistration>,
      order: string[] = [],
    ) {
      const terminate = vi.fn(async () => {});
      const retireTerminalRegistration = vi.fn(async () => { order.push("retire"); });
      const coordinator = new RunnerRecoveryCoordinator({
        nodeId: "node-cell",
        stateDirectory: "/runner",
        leaseTimeoutMs: 120_000,
        scanIntervalMs: 60_000,
        closedTailDrainer: { drain: vi.fn(async () => {}) },
        logger: silentLogger,
        spawner: {
          terminate,
          invalidateRegistration: vi.fn(async () => {}),
          retireTerminalRegistration,
        },
        scan: async () => ({ registrations: [structuredClone(registration)], errors: [] }),
        hydrate: async (item) => item,
        now: () => Date.parse("2026-11-14T01:05:00.000Z"),
        markReaped: vi.fn(async () => {}),
        taskManager: world.manager,
        taskExecutor: world.executor,
      });
      return { coordinator, terminate, retireTerminalRegistration };
    }

    it("노드 시작 때 쌓인 지시는 복구 훑기가 끝난 뒤 한 번 들어간다", async () => {
      for (const pidAlive of [true, false]) {
        const runner: FakeRunner = fakeRunner();
        const world = makeWorld(terminalRow(), { runner });
        const order: string[] = [];
        const registration = runnerRegistration({ pidAlive, lifecycleState: "completed" });
        const { coordinator, retireTerminalRegistration } = coordinatorFor(world, registration, order);
        const runtime = {
          createUpstreamAdapter: () => ({ run: async () => {} }),
          upstreamRegistrationReady: Promise.resolve(),
          runnerRecoveryCoordinator: coordinator,
          claudeRuntimeStartupRecovery: {
            // 재시작 전에 쌓였던 지시가 장부에서 다시 들어오는 자리다. 진짜 recoverQueuedDeliveries 대신
            // 같은 자리에서 addIntervention을 부르는 대역이다. 순서는 진짜 startWorkerRuntime과 코디네이터가 정한다.
            afterRunnerRecovery: async () => {
              order.push("redeliver");
              await world.manager.addIntervention(world.message("쌓인 지시"), world.onResume);
            },
          },
        };

        const onRunnerRecoveryFailure = vi.fn();
        await startWorkerRuntime({
          compose: async () => runtime,
          listen: async () => {},
          logger: silentLogger,
          onUpstreamFailure: () => {},
          onRunnerRecoveryFailure,
        });
        await vi.waitFor(() => expect(world.resumes).toHaveLength(1));
        await coordinator.stop();

        expect(onRunnerRecoveryFailure).not.toHaveBeenCalled();
        // 중앙에 종료가 적힌 세션의 남은 등록은 재생 없이 은퇴시키고, 그 뒤에 쌓인 지시가 든다.
        expect(order).toEqual(["retire", "redeliver"]);
        expect(retireTerminalRegistration).toHaveBeenCalledOnce();
        expect(runner.dispatcher.recoverFrames).not.toHaveBeenCalled();
        expect(world.resumes[0]!.queueAtStart).toEqual(["쌓인 지시"]);
        expect(runner.engine.intervene).not.toHaveBeenCalled();
      }
    });

    it("쌓인 지시가 먼저 다시 띄우면 복구 훑기는 그 세션을 건너뛰고 지시는 한 번 들어간다", async () => {
      for (const pidAlive of [true, false]) {
        const frames = deferred();
        // 새 실행의 러너는 디스크에 남은 옛 등록과 다른 등록이다.
        const runner = fakeRunner({ frames: frames.promise, registrationId: "registration-new" });
        const world = makeWorld(terminalRow(), { runner });
        const task: Task = await hydrate(world);
        task.interventionQueue.push({ text: "쌓인 지시", user: "browser" });
        expect(phaseOf(task)).toBe("idle");
        const registration = runnerRegistration({ pidAlive, lifecycleState: "completed" });
        const { coordinator, terminate, retireTerminalRegistration } = coordinatorFor(world, registration);

        // 운영의 재개 콜백처럼 실제 실행을 연다.
        await world.manager.resumeQueuedAfterTerminal(task, (resumed, activation) => {
          void world.executor.startNewExecution(resumed, cellAgent, activation ?? createExecutionActivation());
        });
        await flush();
        expect(task.runner).toBe(runner.runner);
        await coordinator.scanOnce();
        await coordinator.stop();

        expect(runner.dispatcher.recoverFrames).not.toHaveBeenCalled();
        expect(terminate).not.toHaveBeenCalled();
        expect(retireTerminalRegistration).not.toHaveBeenCalled();
        expect(runner.dispatcher.executeFrames).toHaveBeenCalledOnce();
        expect(task.interventionQueue).toEqual([]);
        frames.resolve();
        await flush();
      }
    });
  });
});
