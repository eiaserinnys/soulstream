/**
 * 카드 #1266 U5b 바깥 요청 칸의 경계 시험이다(남은 기록 재생, 멈추는 중, 종료를 올리는 중).
 * 칸마다 그 실행 상태를 운영 코드로 만든 뒤 TaskManager의 운영 진입 함수로 요청을 보내 나온
 * 처분을 보고, 정의의 판정 함수가 같은 처분을 내는지도 본다. 시험 이름은 `NODE_REQUEST_TABLE`의
 * `test`와 같아야 하고 `tests/task/state/node_barrier_request.test.ts`가 그 대응을 확인한다.
 */
import { describe, expect, it, vi } from "vitest";

import {
  deferred,
  fakeRunner,
  flush,
  makeWorld,
  phaseOf,
  REGISTRATION_ID,
  registeredRow,
  SESSION_ID,
  sessionRow,
  startReplaying,
  startRunning,
  track,
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
  describe("러너의 남은 기록을 올리는 중", () => {
    async function replaying() {
      const frames = deferred();
      // 오프라인 재생의 엔진 프록시는 죽은 러너로 명령을 보내므로 던진다(runner_process_dispatcher.ts).
      const runner = fakeRunner({
        frames: frames.promise,
        engine: {
          intervene: vi.fn(async () => {
            throw new Error(`Runner process is unavailable: ${SESSION_ID}`);
          }),
        },
      });
      const world = makeWorld(registeredRow(), { runner });
      const { task, recovery } = await startReplaying(world);
      expect(phaseOf(task)).toBe("replaying");
      return { world, task, runner, frames, recovery };
    }

    it("남은 기록을 올리는 중에 멈춤이 오면 멈춤 하나로 닫힌다", async () => {
      const { world, task, runner, frames, recovery } = await replaying();
      expectDefinition("replaying", "stop", "interrupt_and_terminate");

      const stopped = track(stopTask(world));
      await flush();
      frames.resolve();
      await recovery;
      await flush();

      expect(stopped.value).toBe(true);
      expect(runner.interrupt).toHaveBeenCalledOnce();
      expectOneTerminal(world, "killed");
      expect(task.status).toBe("interrupted");
    });

    it("남은 기록을 올리는 중에 지시가 오면 대기 줄에 쌓았다가 재생이 끝난 뒤 다시 띄운다", async () => {
      const { world, task, runner, frames, recovery } = await replaying();
      expectDefinition("replaying", "intervene", "deliver_or_queue");

      // 앞선 지시를 넘기는 중에 다음 지시가 와도 차례로 쌓인다(옛 짐작 5번).
      const first = intervene(world, "첫 지시");
      const second = intervene(world, "둘째 지시");
      await expect(first).resolves.toMatchObject({ delivered: false, queued: true });
      await expect(second).resolves.toMatchObject({ delivered: false, queued: true });
      expect(runner.engine.intervene).not.toHaveBeenCalled();
      expect(task.interventionQueue.map((message) => message.text)).toEqual(["첫 지시", "둘째 지시"]);
      expect(world.resumes).toHaveLength(0);

      frames.resolve();
      await recovery;
      await flush();
      expect(world.resumes.map((record) => record.queueAtStart)).toEqual([["첫 지시", "둘째 지시"]]);
    });

    it("남은 기록을 올리는 중에 지우면 멈춘 뒤 지운다", async () => {
      const { world, frames, recovery } = await replaying();
      expectDefinition("replaying", "delete", "stop_then_delete");

      const deleted = track(deleteTask(world));
      await flush();
      frames.resolve();
      await recovery;
      await flush();
      expect(deleted.value).toBe(true);
      expectOneTerminal(world, "killed");
      expect(world.deleteSession).toHaveBeenCalledOnce();
    });

    it("남은 기록을 올리는 중에 재개가 오면 새 실행을 시작하지 않는다", async () => {
      const { world, frames } = await replaying();
      expectDefinition("replaying", "resume", "reject_runner_attached");

      await expect(resume(world)).resolves.toMatchObject({
        state: "already_running",
        execution: { registrationId: REGISTRATION_ID },
      });
      expect(world.resumes).toHaveLength(0);
      frames.resolve();
    });

    it("남은 기록을 올리는 중 넘기기를 기다리던 멈춤은 넘기기가 끝난 뒤 멈춤으로 닫힌다", async () => {
      const { world, task, runner, frames, recovery } = await replaying();
      // 지시 접수 사건의 영속이 끝나지 않아 넘기기 장벽이 서 있는 동안 멈춤이 온다.
      const accepted = deferred();
      const persist = world.persistenceDouble.enqueueEvent;
      const original = persist.getMockImplementation()!;
      persist.mockImplementation(async (...args: Parameters<typeof original>) => {
        if ((args[1] as { type?: string }).type === "intervention_sent") await accepted.promise;
        return await original(...args);
      });
      const handoff = intervene(world, "넘기는 지시");
      await flush();
      expect(task.interruptBarrierKind).toBe("intervention_handoff");

      const stopped = track(stopTask(world));
      await flush();
      expect(runner.interrupt).not.toHaveBeenCalled();
      accepted.resolve();
      await expect(handoff).resolves.toMatchObject({ queued: true });
      await flush();
      frames.resolve();
      await recovery;
      await flush();

      expect(stopped.value).toBe(true);
      expect(runner.interrupt).toHaveBeenCalledOnce();
      expectOneTerminal(world, "killed");
      expect(task.status).toBe("interrupted");
    });
  });

  describe("멈추는 중", () => {
    async function stopping() {
      const frames = deferred();
      const interrupted = deferred<boolean>();
      const runner = fakeRunner({ frames: frames.promise, interrupt: async () => await interrupted.promise });
      const world = makeWorld(sessionRow(), { runner });
      const task = await startRunning(world);
      const firstStop = track(stopTask(world));
      await flush();
      expect(phaseOf(task)).toBe("stopping");
      return {
        world,
        task,
        runner,
        firstStop,
        async finish() {
          interrupted.resolve(true);
          await flush();
          frames.resolve();
          await flush();
        },
      };
    }

    it("멈추는 중에 멈춤이 오면 앞선 멈춤에 붙는다", async () => {
      const { world, runner, firstStop, finish } = await stopping();
      expectDefinition("stopping", "stop", "join_stop");

      const joined = track(stopTask(world));
      await flush();
      expect(joined.settled).toBe(false);
      await finish();
      expect([firstStop.value, joined.value]).toEqual([true, true]);
      expect(runner.interrupt).toHaveBeenCalledOnce();
      expectOneTerminal(world, "killed");
    });

    it("멈추는 중에 지시가 오면 멈추는 턴의 엔진에 넘긴다", async () => {
      const { world, runner, finish } = await stopping();
      expectDefinition("stopping", "intervene", "deliver_or_queue");

      await expect(intervene(world)).resolves.toEqual({ delivered: true });
      expect(runner.engine.intervene).toHaveBeenCalledOnce();
      await finish();
      expectOneTerminal(world, "killed");
      expect(world.resumes).toHaveLength(0);
    });

    it("멈추는 중에 지우면 멈춤 마무리를 기다린 뒤 지운다", async () => {
      const { world, runner, finish } = await stopping();
      expectDefinition("stopping", "delete", "stop_then_delete");

      const deleted = track(deleteTask(world));
      await flush();
      expect(world.deleteSession).not.toHaveBeenCalled();
      await finish();
      expect(deleted.value).toBe(true);
      expect(runner.interrupt).toHaveBeenCalledOnce();
      expectOneTerminal(world, "killed");
      expect(world.deleteSession).toHaveBeenCalledOnce();
    });

    it("멈추는 중에 재개가 오면 새 실행을 시작하지 않는다", async () => {
      const { world, finish } = await stopping();
      expectDefinition("stopping", "resume", "reject_runner_attached");

      await expect(resume(world)).resolves.toMatchObject({ state: "already_running" });
      expect(world.resumes).toHaveLength(0);
      await finish();
    });
  });

  describe("종료를 올리는 중", () => {
    async function terminating() {
      const frames = deferred();
      const runner = fakeRunner({ frames: frames.promise });
      const world = makeWorld(sessionRow(), { runner });
      const task = await startRunning(world);
      const terminal = world.holdNextTerminalAnswer();
      frames.resolve();
      await flush();
      expect(phaseOf(task)).toBe("terminating");
      return {
        world,
        task,
        runner,
        async finish() {
          terminal.resolve();
          await flush();
        },
      };
    }

    it("종료를 올리는 중에 멈춤이 오면 거짓을 돌려준다", async () => {
      const { world, runner, finish } = await terminating();
      expectDefinition("terminating", "stop", "reject_not_running");

      await expect(stopTask(world)).resolves.toBe(false);
      await finish();
      expect(runner.interrupt).not.toHaveBeenCalled();
      expectOneTerminal(world, "completed_ok");
    });

    it("종료를 올리는 중에 지시가 오면 종료가 끝난 뒤 다시 띄운다", async () => {
      const { world, finish } = await terminating();
      expectDefinition("terminating", "intervene", "queue_and_restart");

      const resumed = track(intervene(world));
      await flush();
      expect(resumed.settled).toBe(false);
      await finish();
      expect(resumed.value).toEqual({ autoResumed: true });
      expect(world.resumes.map((record) => record.queueAtStart)).toEqual([["새 지시"]]);
      expectOneTerminal(world, "completed_ok");
    });

    it("종료를 올리는 중에 지우면 줄을 지운다", async () => {
      const { world, finish } = await terminating();
      expectDefinition("terminating", "delete", "delete_row");

      await expect(deleteTask(world)).resolves.toBe(true);
      expect(world.deleteSession).toHaveBeenCalledOnce();
      await finish();
      expectOneTerminal(world, "completed_ok");
    });

    it("종료를 올리는 중에 재개가 오면 새 실행을 시작하지 않는다", async () => {
      const { world, finish } = await terminating();
      expectDefinition("terminating", "resume", "reject_runner_attached");

      await expect(resume(world)).resolves.toMatchObject({ state: "already_running" });
      expect(world.resumes).toHaveLength(0);
      await finish();
    });
  });
});
